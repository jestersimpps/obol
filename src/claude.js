const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { refreshTokens, isExpired, isOAuthToken } = require('./oauth');
const { saveConfig, loadConfig, OBOL_DIR } = require('./config');
const { execAsync, isAllowedUrl } = require('./sanitize');
const { ChatHistory } = require('./history');

const MAX_EXEC_TIMEOUT = 120;
let MAX_TOOL_ITERATIONS = 100;

const BLOCKED_EXEC_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive)\b/,
  /\bshutdown\b/, /\breboot\b/, /\bpoweroff\b/,
  /\bmkfs\b/, /\bdd\s+if=/, /\b:()\{\s*:|:&\s*\};:/,
  /\bchmod\s+(-R\s+)?[0-7]*\s+\/[^t]/,
  />\s*\/etc\//, />\s*\/boot\//,
  /\bcurl\b.*\|\s*(ba)?sh/, /\bwget\b.*\|\s*(ba)?sh/,
  /\bnc\s+-e\b/, /\bncat\b.*-e\b/,
  />\s*\/dev\/sd/,
];

const SENSITIVE_READ_PATHS = [
  /\/etc\/(passwd|shadow|sudoers)/,
  /\/etc\/ssh\//,
  /\.(env|pem|key|crt|p12|pfx)(\s|$)/,
  /~\/\.ssh\//,
  /~\/\.gnupg\//,
  /\/root\//,
];

function createAnthropicClient(anthropicConfig, { useOAuth = true } = {}) {
  if (useOAuth && anthropicConfig.oauth?.accessToken) {
    return new Anthropic({
      apiKey: null,
      authToken: anthropicConfig.oauth.accessToken,
      defaultHeaders: {
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      },
    });
  }
  if (anthropicConfig.apiKey) {
    return new Anthropic({ apiKey: anthropicConfig.apiKey });
  }
  throw new Error('No Anthropic credentials configured. Run: obol config');
}

let _refreshPromise = null;

async function ensureFreshToken(anthropicConfig) {
  if (!anthropicConfig.oauth?.accessToken) return;
  if (!isExpired(anthropicConfig.oauth)) return;
  if (!anthropicConfig.oauth.refreshToken) {
    if (anthropicConfig.apiKey) {
      anthropicConfig._oauthFailed = true;
      return;
    }
    const err = new Error('OAuth token expired and no refresh token available. Re-authenticate with: obol config → Anthropic → OAuth');
    err.isOAuthExpiry = true;
    throw err;
  }

  if (_refreshPromise) {
    try {
      await _refreshPromise;
    } catch {}
    if (!isExpired(anthropicConfig.oauth)) return;
    if (anthropicConfig._oauthFailed) return;
  }

  _refreshPromise = (async () => {
    try {
      const tokens = await refreshTokens(anthropicConfig.oauth.refreshToken);
      console.log('[oauth] Refresh succeeded, new refresh token:', !!tokens.refreshToken);
      anthropicConfig.oauth.accessToken = tokens.accessToken;
      if (tokens.refreshToken) anthropicConfig.oauth.refreshToken = tokens.refreshToken;
      anthropicConfig.oauth.expires = tokens.expires;
      delete anthropicConfig._oauthFailed;

      const config = loadConfig({ resolve: false });
      if (config) {
        config.anthropic.oauth = anthropicConfig.oauth;
        saveConfig(config);
      }
    } catch (e) {
      console.warn('[oauth] Refresh failed, checking disk for updated tokens:', e.message);
      const diskConfig = loadConfig({ resolve: false });
      if (diskConfig?.anthropic?.oauth?.accessToken &&
          diskConfig.anthropic.oauth.accessToken !== anthropicConfig.oauth.accessToken &&
          !isExpired(diskConfig.anthropic.oauth)) {
        anthropicConfig.oauth.accessToken = diskConfig.anthropic.oauth.accessToken;
        anthropicConfig.oauth.refreshToken = diskConfig.anthropic.oauth.refreshToken;
        anthropicConfig.oauth.expires = diskConfig.anthropic.oauth.expires;
        delete anthropicConfig._oauthFailed;
        return;
      }

      if (anthropicConfig.apiKey) {
        console.warn('[oauth] Token refresh failed, falling back to API key:', e.message);
        anthropicConfig._oauthFailed = true;
      } else {
        const err = new Error(`OAuth token expired and refresh failed: ${e.message}`);
        err.isOAuthExpiry = true;
        throw err;
      }
    }
  })();

  try {
    await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}

function createClaude(anthropicConfig, { personality, memory, userDir = OBOL_DIR, bridgeEnabled }) {
  let client = createAnthropicClient(anthropicConfig);

  let baseSystemPrompt = buildSystemPrompt(personality, userDir, { bridgeEnabled });

  const histories = new ChatHistory(50);
  const chatLocks = new Map();
  const chatAbortControllers = new Map();

  const tools = buildTools(memory, { bridgeEnabled });

  function acquireChatLock(chatId) {
    if (!chatLocks.has(chatId)) chatLocks.set(chatId, { promise: Promise.resolve(), busy: false });
    const lock = chatLocks.get(chatId);
    let release;
    const prev = lock.promise;
    lock.promise = new Promise(r => { release = r; });
    return prev.then(() => {
      lock.busy = true;
      return () => { lock.busy = false; release(); };
    });
  }

  function isChatBusy(chatId) {
    return chatLocks.get(chatId)?.busy || false;
  }

  async function chat(userMessage, context = {}) {
    context.userDir = userDir;
    const chatId = context.chatId || 'default';

    if (isChatBusy(chatId)) {
      return { text: 'I\'m still working on the previous request. Give me a moment.', usage: null, model: null };
    }

    const releaseLock = await acquireChatLock(chatId);
    const abortController = new AbortController();
    chatAbortControllers.set(chatId, abortController);

    const history = histories.get(chatId);

    try {

    if (anthropicConfig.oauth?.accessToken) {
      await ensureFreshToken(anthropicConfig);
      if (anthropicConfig._oauthFailed) {
        client = createAnthropicClient(anthropicConfig, { useOAuth: false });
      } else {
        client = createAnthropicClient(anthropicConfig, { useOAuth: true });
      }
    }

    const verbose = context.verbose || false;
    if (verbose) context.verboseLog = [];
    const vlog = (msg) => {
      if (!verbose) return;
      context.verboseLog.push(msg);
      context._verboseNotify?.(msg);
    };

    let memoryContext = '';
    if (memory) {
      try {
        const memoryDecision = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 100,
          system: `You are a router. Analyze this user message and decide two things:

1. Does it need memory context? (past conversations, facts, preferences, people, events)
2. What model complexity does it need?

Reply with ONLY a JSON object:
{"need_memory": true/false, "search_query": "optimized search query", "model": "haiku|sonnet|opus"}

Memory: casual messages (greetings, jokes, simple questions) → false. References to past, people, projects, preferences → true with optimized search query.

Model: Default to "sonnet". Use "haiku" for: greetings, brief acknowledgments (thanks/ok/bye), casual chitchat, simple factual questions with short answers, quick yes/no questions, and short single-turn exchanges that don't need deep reasoning. Use "sonnet" for: code generation, data analysis, content creation, explanations, creative writing, agentic tool use, general questions, opinions, advice, and most conversational exchanges with substance. Use "opus" for: professional software engineering tasks, advanced multi-step agent work, complex reasoning, scientific or mathematical problems, tasks requiring nuanced understanding, advanced coding challenges, in-depth research, and architecture or design decisions.`,
          messages: [{ role: 'user', content: userMessage }],
        });

        const decisionText = memoryDecision.content[0]?.text || '';
        let decision = {};
        try {
          const jsonStr = decisionText.match(/\{[^{}]*\}/)?.[0];
          if (jsonStr) decision = JSON.parse(jsonStr);
        } catch {}

        vlog(`[router] model=${decision.model || 'sonnet'} memory=${decision.need_memory || false}${decision.search_query ? ` query="${decision.search_query}"` : ''}`);

        if (decision.model === 'opus') {
          context._model = 'claude-opus-4-6';
        } else if (decision.model === 'haiku') {
          context._model = 'claude-haiku-4-5';
        }

        if (decision.need_memory) {
          const query = decision.search_query || userMessage;

          const todayMemories = await memory.byDate('today', { limit: 3 });
          const semanticMemories = await memory.search(query, { limit: 3, threshold: 0.5 });

          const seen = new Set();
          const combined = [];
          for (const m of [...todayMemories, ...semanticMemories]) {
            if (!seen.has(m.id)) {
              seen.add(m.id);
              combined.push(m);
            }
          }

          vlog(`[memory] ${combined.length} memories found (${todayMemories.length} today, ${semanticMemories.length} semantic)`);

          if (combined.length > 0) {
            memoryContext = '\n\n[Relevant memories]\n' +
              combined.map(m => `- [${m.category}] ${m.content}`).join('\n');
          }
        }
      } catch (e) {
        console.error('[router] Memory/routing decision failed:', e.message);
        vlog(`[router] ERROR: ${e.message}`);
      }
    }

    histories.prune(chatId);

    const enrichedMessage = memoryContext
      ? userMessage + memoryContext
      : userMessage;
    if (context.images?.length) {
      histories.pushUser(chatId, [...context.images, { type: 'text', text: enrichedMessage }]);
    } else {
      histories.pushUser(chatId, enrichedMessage);
    }

    const model = context._model || 'claude-sonnet-4-6';
    vlog(`[model] ${model} | history=${history.length} msgs`);
    const systemPrompt = baseSystemPrompt + `\nCurrent time: ${new Date().toISOString()}`;
    const runnableTools = buildRunnableTools(tools, memory, context, vlog);

    const runner = client.beta.messages.toolRunner({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [...history],
      tools: runnableTools.length > 0 ? runnableTools : undefined,
      max_iterations: MAX_TOOL_ITERATIONS,
    }, { signal: abortController.signal });

    let finalMessage;
    let totalUsage = { input_tokens: 0, output_tokens: 0 };
    for await (const message of runner) {
      finalMessage = message;
      if (message.usage) {
        totalUsage.input_tokens += message.usage.input_tokens || 0;
        totalUsage.output_tokens += message.usage.output_tokens || 0;
        vlog(`[tokens] in=${message.usage.input_tokens} out=${message.usage.output_tokens}`);
      }
    }

    const runnerMessages = runner.params.messages;
    const newMessages = runnerMessages.slice(history.length);
    histories.pushMessages(chatId, newMessages);

    if (finalMessage.stop_reason === 'tool_use') {
      const bailoutResults = finalMessage.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '[max tool iterations reached]' }));
      histories.pushUser(chatId, [
        ...bailoutResults,
        { type: 'text', text: 'You have used too many tool calls. Please provide a final response now based on what you have so far.' },
      ]);
      const bailoutResponse = await client.messages.create({
        model, max_tokens: 4096, system: systemPrompt, messages: [...histories.get(chatId)],
      }, { signal: abortController.signal });
      histories.pushAssistant(chatId, bailoutResponse.content);
      if (bailoutResponse.usage) {
        totalUsage.input_tokens += bailoutResponse.usage.input_tokens || 0;
        totalUsage.output_tokens += bailoutResponse.usage.output_tokens || 0;
      }
      const text = bailoutResponse.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { text, usage: totalUsage, model };
    }

    const text = finalMessage.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    return { text, usage: totalUsage, model };

    } catch (e) {
      if (e.message === 'Request was aborted.' || e.constructor?.name === 'APIUserAbortError') {
        return { text: null, usage: null, model: null };
      }
      if (e.status === 400 && e.message?.includes('tool_use')) {
        console.error('[claude] Repairing corrupted history after 400 error');
        histories.repair(chatId);
      }
      throw e;
    } finally {
      chatAbortControllers.delete(chatId);
      releaseLock();
    }
  }

  function stopChat(chatId) {
    const controller = chatAbortControllers.get(chatId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  function reloadPersonality() {
    const pDir = userDir ? path.join(userDir, 'personality') : undefined;
    const newPersonality = require('./personality').loadPersonality(pDir);
    for (const key of Object.keys(personality)) delete personality[key];
    Object.assign(personality, newPersonality);
    baseSystemPrompt = buildSystemPrompt(personality, userDir, { bridgeEnabled });
  }

  function clearHistory(chatId) {
    if (chatId) {
      histories.delete(chatId);
    } else {
      histories.clear();
    }
  }

  function injectHistory(chatId, role, content) {
    histories.inject(chatId, role, content);
  }

  function getContextStats(chatId) {
    const id = chatId || 'default';
    return histories.estimateTokens(id, baseSystemPrompt.length);
  }

  return { chat, client, reloadPersonality, clearHistory, injectHistory, getContextStats, stopChat };
}

function buildSystemPrompt(personality, userDir, opts = {}) {
  const parts = [];

  // Identity core
  parts.push('You are OBOL, a personal AI agent running 24/7 on a server. You have persistent memory, can execute shell commands, deploy websites, and learn over time. You are not a generic chatbot — you are a dedicated agent for one person.');

  // Personality (from SOUL.md)
  if (personality.soul) {
    parts.push(`\n## Personality\n${personality.soul}`);
  } else {
    parts.push(`\n## Personality\nYou are a fresh instance. Be helpful, direct, and naturally curious. Pay attention to how your owner communicates and adapt. Your personality will develop through conversation and periodic evolution.`);
  }

  // Trait calibration
  if (personality.traits) {
    const t = personality.traits;
    const descriptions = {
      humor: [0, 'suppress all wit', 50, 'balanced wit', 100, 'lean heavily into jokes and playfulness'],
      honesty: [0, 'maximize diplomatic softening', 50, 'balanced honesty', 100, 'lean toward blunt truth'],
      directness: [0, 'elaborate context and preamble', 50, 'balanced', 100, 'get straight to the point'],
      curiosity: [0, 'only answer what is asked', 50, 'balanced', 100, 'proactively explore and ask follow-ups'],
      empathy: [0, 'purely task-focused', 50, 'balanced', 100, 'deeply emotionally attuned'],
      creativity: [0, 'stick to proven patterns', 50, 'balanced', 100, 'favor novel approaches'],
    };
    const lines = Object.entries(t).map(([trait, val]) => {
      const desc = descriptions[trait];
      if (!desc) return null;
      const label = val <= 30 ? desc[1] : val <= 70 ? desc[3] : desc[5];
      return `- ${trait.charAt(0).toUpperCase() + trait.slice(1)}: ${val} — ${label}`;
    }).filter(Boolean);
    parts.push(`\n## Personality Calibration\n\nThese values (0-100) define your behavioral tendencies:\n${lines.join('\n')}\n\nInterpret these as a spectrum: 0 = suppress entirely, 50 = balanced, 100 = lean heavily into it.`);
  }

  // Owner context (from USER.md)
  if (personality.user) {
    parts.push(`\n## About Your Owner\n${personality.user}`);
  } else {
    parts.push(`\n## About Your Owner\nYou don't know anything about your owner yet. Pay attention to everything they share — name, job, interests, preferences, people they mention. Store important details in memory. You'll learn naturally through conversation.`);
  }

  // Operating instructions (from AGENTS.md — always present via default)
  if (personality.agents) {
    parts.push(`\n## Operating Instructions\n${personality.agents}`);
  }

  // Workspace discipline
  const workDir = userDir || '~/.obol';
  const userId = userDir ? path.basename(userDir) : null;
  const passPrefix = userId ? `obol/users/${userId}` : 'obol';

  parts.push(`
## Workspace Discipline

Your workspace directory (${workDir}) has a fixed structure:

\`\`\`
${workDir}/
├── personality/    (SOUL.md, USER.md, AGENTS.md, evolution/)
├── scripts/        (utility scripts)
├── tests/          (test suite)
├── commands/       (command definitions)
├── apps/           (web apps for Vercel)
├── assets/         (uploaded files, images, media)
└── logs/
\`\`\`

**Rules:**
- NEVER create new top-level directories unless the user explicitly asks for one.
- Place files in the correct existing directory. Scripts → scripts/, tests → tests/, etc.
- Temporary files go in /tmp, not in the OBOL directory.
- If unsure where something belongs, ask — don't guess.
- Run \`/clean\` to audit and fix misplaced files.

## Secrets

Use the \`store_secret\`, \`read_secret\`, and \`list_secrets\` tools for all user credential operations.
These store secrets under the prefix \`${passPrefix}/\` in pass (or JSON fallback).

Users can also manage secrets via Telegram: \`/secret set <key> <value>\` (message auto-deleted), \`/secret list\`, \`/secret remove <key>\`.
Since users can store secrets via /secret outside your conversation, ALWAYS call \`list_secrets\` to check what's available before telling the user their credentials aren't stored.

Shared bot credentials live under \`obol/\` — do NOT touch or re-create these:
\`obol/anthropic-key\`, \`obol/telegram-token\`, \`obol/supabase-url\`, \`obol/supabase-key\`, \`obol/github-token\`, \`obol/vercel-token\`
`);

  // Bridge (conditional)
  if (opts.bridgeEnabled) {
    parts.push(`
## Bridge (Partner Agent)

You have two bridge tools for communicating with your owner's partner's AI agent:

- \`bridge_ask\` — Ask the partner's agent a question. Use when the user asks about the other person's preferences, schedule, mood, opinions, or anything their agent would know. The partner's agent answers from its own memory and personality.
- \`bridge_tell\` — Send a message to the partner's agent. Use when the user wants to tell, remind, or send something to the other person. The message gets stored in the partner's memory and delivered via Telegram.

Both tools notify the partner that their agent was contacted. Keep messages specific and concise.
`);
  }

  // Tool documentation (hardcoded — never drifts)
  parts.push(`
## Tools

### Shell (\`exec\`)
Run shell commands. Workspace is your home directory.
- Timeout: 30s default, 120s max
- Blocked: \`rm -rf\`, \`shutdown\`, \`eval\`, \`bash -c\`, backtick injection, pipe-to-shell
- Sensitive paths blocked: \`/etc/passwd\`, \`.env\`, \`.ssh/\`, \`/root/\`

### Memory (\`memory_search\`, \`memory_add\`, \`memory_date\`)
Vector memory via Supabase pgvector with local embeddings.
- \`memory_search\` — semantic search across all memories
- \`memory_add\` — store facts, decisions, preferences, events, people, projects
- \`memory_date\` — get memories by date ("today", "yesterday", "7d", "2026-02-22")

Categories: \`fact\`, \`preference\`, \`decision\`, \`lesson\`, \`person\`, \`project\`, \`event\`, \`conversation\`, \`resource\`, \`pattern\`, \`context\`, \`email\`

### Files (\`read_file\`, \`write_file\`)
Read and write files within your workspace. Parent directories created automatically.
Cannot access paths outside workspace or /tmp.

### Web (\`web_fetch\`)
Fetch and extract readable content from any URL via Jina reader.

### Vercel (\`vercel_deploy\`, \`vercel_list\`)
Deploy directories to Vercel. Ship websites, dashboards, web apps.

### Background Tasks (\`background_task\`)
Spawn heavy work (research, site building, complex analysis) in the background.
The main conversation stays responsive. User gets progress updates every 30s.
After spawning, reply with a brief acknowledgment.

### Secrets (\`store_secret\`, \`read_secret\`, \`list_secrets\`)
Per-user encrypted secret store (pass or JSON fallback).
- \`store_secret\` — store a key/value secret (API keys, passwords, tokens)
- \`read_secret\` — read a secret by key
- \`list_secrets\` — list all secret keys (keys only, not values)

Use these tools instead of \`exec\` for storing/reading secrets — they bypass the \`bash -c\` restriction.

### Send File (\`send_file\`)
Send a file back to the user via Telegram. Use after generating PDFs, images, documents, or any file the user requested.

### Ask User (\`telegram_ask\`)
Send a message with inline keyboard buttons and wait for the user to tap one. Use for human-in-the-loop decisions before taking action.

Examples:
- After listing emails: \`telegram_ask({message: "Open any of these?", options: ["#1 Google", "#2 LinkedIn", "#3 DeepLearning", "None"]})\`
- Before sending a reply: \`telegram_ask({message: "Send this reply?", options: ["Send it", "Edit first", "Cancel"]})\`
- Before an irreversible action: \`telegram_ask({message: "Archive all read emails?", options: ["Yes", "No"]})\`

Returns the tapped button label, or \`"timeout"\` if the user doesn't respond within the timeout (default 60s).

### Scheduling (\`schedule_event\`, \`list_events\`, \`cancel_event\`)
Schedule reminders and events. The user gets a Telegram message when the time comes.
- \`schedule_event\` — schedule a reminder with title, due_at (ISO 8601), timezone (IANA), optional description
- \`list_events\` — list pending/sent/cancelled events
- \`cancel_event\` — cancel a scheduled event by ID

When scheduling: always search memory first for the user's timezone/location. If no timezone found, ask the user or default to UTC. Parse natural language dates relative to the user's timezone.

### Bridge (\`bridge_ask\`, \`bridge_tell\`)
Only available if bridge is enabled. Communicate with partner's AI agent.
`);

  // Available custom scripts (dynamic — always current)
  const scriptsDir = userDir ? path.join(userDir, 'scripts') : null;
  let scriptManifest = '(no custom scripts yet)';
  if (scriptsDir && fs.existsSync(scriptsDir)) {
    try {
      const scriptFiles = fs.readdirSync(scriptsDir).filter(f => {
        try { return fs.statSync(path.join(scriptsDir, f)).isFile(); } catch { return false; }
      });
      if (scriptFiles.length > 0) {
        scriptManifest = scriptFiles.map(s => `- ${s}`).join('\n');
      }
    } catch {}
  }
  parts.push(`\n## Available Scripts\nScripts you've built in your workspace (run via exec tool):\n${scriptManifest}`);

  // Telegram formatting (hardcoded — never drifts)
  parts.push(`
## Telegram Formatting

You communicate via Telegram. Format responses for mobile readability.

**Never use markdown tables** — pipe-syntax tables do not render in Telegram. Use numbered lists instead.

**Email/inbox lists** — use this pattern:
\`\`\`
📬 *Inbox (10)*

1\\. *Google* — Security alert \`22:58\`
2\\. *LinkedIn* — Matthew Chittle wants to connect \`21:31\`
3\\. *DeepLearning\\.AI* — AI Dev 26 × SF speakers \`13:20\`
4\\. *LinkedIn Jobs* — Project Manager / TPM roles \`17:32\`
\`\`\`

**Copyable values** (email addresses, URLs, API keys, commands) — wrap in backtick code spans:
\`user@example.com\`, \`https://example.com\`, \`npm install foo\`

**Human-in-the-loop** — after listing emails or before acting, use \`telegram_ask\` to offer inline buttons rather than asking the user to type a reply.

**Keep lines short** — Telegram wraps long lines poorly on mobile. Break at natural points.
`);

  // Safety rules (hardcoded — never drifts)
  parts.push(`
## Safety Rules

### Never
- Share owner's private data with anyone
- Run destructive commands without asking (\`rm -rf\`, \`DROP TABLE\`, etc.)
- Send emails or messages on behalf of owner — draft them, owner sends
- Modify system files (\`/etc/\`, \`/boot/\`)
- Store secrets in plaintext — use \`store_secret\` for sensitive data
- Create files outside workspace (except /tmp)
- Hardcode credentials in scripts — always read them via \`read_secret\` at runtime

### Always
- Draft emails/posts for review before sending
- Ask before running anything irreversible
- Store important info in memory proactively
- Search memory before claiming you don't know something
- Use \`store_secret\`/\`read_secret\` for all credential operations
`);

  return parts.join('\n');
}

function buildTools(memory, opts = {}) {
  const tools = [];

  // Shell execution
  tools.push({
    name: 'exec',
    description: 'Execute a shell command and return the output. Use for file operations, system tasks, running scripts.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 30)' },
      },
      required: ['command'],
    },
  });

  // Memory tools
  if (memory) {
    tools.push({
      name: 'memory_search',
      description: 'Search vector memory for relevant past context. Use before answering questions about prior conversations, decisions, or facts.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results (default 10)' },
          category: { type: 'string', description: 'Filter by category' },
        },
        required: ['query'],
      },
    });

    tools.push({
      name: 'memory_add',
      description: 'Store a new memory. Use to remember facts, decisions, preferences, events.',
      input_schema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'What to remember' },
          category: { type: 'string', enum: ['fact', 'preference', 'decision', 'lesson', 'person', 'project', 'event', 'conversation', 'resource', 'pattern', 'context', 'email'], description: 'Memory category' },
          importance: { type: 'number', description: 'Importance 0-1 (default 0.5)' },
          source: { type: 'string', description: 'Where this came from' },
        },
        required: ['content'],
      },
    });

    tools.push({
      name: 'memory_date',
      description: 'Get memories from a specific date. Use for "what did we do today/yesterday" questions.',
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date: "today", "yesterday", "2026-02-22", "7d"' },
          category: { type: 'string', description: 'Filter by category' },
        },
        required: ['date'],
      },
    });
  }

  // Web fetch
  tools.push({
    name: 'web_fetch',
    description: 'Fetch and extract readable content from a URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
  });

  // Vercel deploy
  tools.push({
    name: 'vercel_deploy',
    description: 'Deploy a directory to Vercel. Use to ship websites, dashboards, and web apps for the user.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Path to the project directory to deploy' },
        name: { type: 'string', description: 'Project name' },
        production: { type: 'boolean', description: 'Deploy to production (default false = preview)' },
      },
      required: ['directory'],
    },
  });

  tools.push({
    name: 'vercel_list',
    description: 'List Vercel deployments for a project.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name' },
      },
      required: ['project'],
    },
  });

  // Background task
  tools.push({
    name: 'background_task',
    description: 'Spawn a heavy task in the background. Use when a request will take multiple steps (research, building a site, complex analysis). The main conversation stays responsive. The user gets progress check-ins every 30s and the final result when done. Reply to the user with a brief acknowledgment like "On it 🪙" after spawning.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Detailed description of the task to complete' },
      },
      required: ['task'],
    },
  });

  // Read/write files
  tools.push({
    name: 'read_file',
    description: 'Read contents of a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
  });

  tools.push({
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    },
  });

  tools.push({
    name: 'store_secret',
    description: 'Store a secret (API key, password, token) in the per-user encrypted secret store. Use when the user provides credentials for services.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Secret name (e.g. gmail-password, notion-token)' },
        value: { type: 'string', description: 'Secret value' },
      },
      required: ['key', 'value'],
    },
  });

  tools.push({
    name: 'read_secret',
    description: 'Read a secret by key from the per-user secret store.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Secret name to read' },
      },
      required: ['key'],
    },
  });

  tools.push({
    name: 'list_secrets',
    description: 'List all secret keys stored for this user (keys only, not values).',
    input_schema: {
      type: 'object',
      properties: {},
    },
  });

  tools.push({
    name: 'send_file',
    description: 'Send a file to the user via Telegram (PDF, image, document, etc). Use after generating files the user requested.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to send' },
        caption: { type: 'string', description: 'Optional caption for the file' },
      },
      required: ['path'],
    },
  });

  tools.push({
    name: 'telegram_ask',
    description: 'Send a message to the user with inline keyboard buttons and wait for their tap. Use for human-in-the-loop decisions: confirmations, approvals, action selection. Returns the label of the button the user pressed, or "timeout" if they don\'t respond within the timeout.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Question or prompt to show the user' },
        options: { type: 'array', items: { type: 'string' }, description: 'Button labels (2-6 options, keep each label short)' },
        timeout: { type: 'number', description: 'Seconds to wait for response (default 60)' },
      },
      required: ['message', 'options'],
    },
  });

  tools.push({
    name: 'schedule_event',
    description: 'Schedule a reminder or event. The user will receive a Telegram message when the time comes. Always search memory first for the user\'s timezone/location. If no timezone found, ask the user or default to UTC.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the reminder/event' },
        due_at: { type: 'string', description: 'ISO 8601 datetime string for when the event is due (e.g. 2026-02-25T15:00:00)' },
        timezone: { type: 'string', description: 'IANA timezone (e.g. Europe/Brussels, America/New_York). Default: UTC' },
        description: { type: 'string', description: 'Optional longer description' },
      },
      required: ['title', 'due_at'],
    },
  });

  tools.push({
    name: 'list_events',
    description: 'List scheduled events/reminders for the user.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'sent', 'cancelled'], description: 'Filter by status (default: pending)' },
      },
    },
  });

  tools.push({
    name: 'cancel_event',
    description: 'Cancel a scheduled event/reminder by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'UUID of the event to cancel' },
      },
      required: ['event_id'],
    },
  });

  if (opts.bridgeEnabled) {
    const { buildBridgeTool, buildBridgeTellTool } = require('./bridge');
    tools.push(buildBridgeTool());
    tools.push(buildBridgeTellTool());
  }

  return tools;
}

function buildRunnableTools(tools, memory, context, vlog) {
  return tools.map(tool => ({
    ...tool,
    run: async (input) => {
      const inputSummary = tool.name === 'exec' ? input.command :
        tool.name === 'write_file' ? input.path :
        tool.name === 'read_file' ? input.path :
        tool.name === 'memory_search' ? input.query :
        tool.name === 'memory_add' ? `[${input.category || 'fact'}]` :
        tool.name === 'web_fetch' ? input.url :
        tool.name === 'background_task' ? input.task?.substring(0, 60) :
        tool.name === 'schedule_event' ? `${input.title} @ ${input.due_at}` :
        tool.name === 'cancel_event' ? input.event_id :
        JSON.stringify(input).substring(0, 80);
      vlog(`[tool] ${tool.name}: ${inputSummary}`);
      return await executeToolCall({ name: tool.name, input }, memory, context);
    },
  }));
}

function resolveUserPath(inputPath, userDir) {
  if (!userDir) throw new Error('userDir is required for path resolution');
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(userDir, inputPath);
  const normalizedUser = path.resolve(userDir);

  const isInsideAllowed = (p) =>
    p.startsWith(normalizedUser + path.sep) || p === normalizedUser || p.startsWith('/tmp');

  if (!isInsideAllowed(resolved)) {
    throw new Error(`Path "${inputPath}" is outside your workspace. Use paths relative to your workspace or /tmp.`);
  }

  let realResolved = resolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      if (!isInsideAllowed(realParent)) {
        throw new Error(`Path "${inputPath}" resolves outside your workspace via symlink.`);
      }
      realResolved = path.join(realParent, path.basename(resolved));
    } catch (e) {
      if (e.message.includes('symlink')) throw e;
    }
  }

  if (!isInsideAllowed(realResolved)) {
    throw new Error(`Path "${inputPath}" resolves outside your workspace via symlink. Symlinks to external paths are blocked.`);
  }
  return realResolved;
}

async function executeToolCall(toolUse, memory, context = {}) {
  const { name, input } = toolUse;
  const userDir = context.userDir;

  try {
    switch (name) {
      case 'exec': {
        for (const pattern of BLOCKED_EXEC_PATTERNS) {
          if (pattern.test(input.command)) {
            return `Blocked: "${input.command}" matches a dangerous pattern. Ask the user for confirmation first.`;
          }
        }
        if (userDir) {
          for (const pattern of SENSITIVE_READ_PATHS) {
            if (pattern.test(input.command)) {
              return `Blocked: command accesses a sensitive path. Ask the user for confirmation first.`;
            }
          }
        }
        const timeout = Math.min(input.timeout || 30, MAX_EXEC_TIMEOUT) * 1000;
        const realHome = process.env.HOME || '/root';
        const output = await execAsync(input.command, {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 1024 * 1024,
          cwd: userDir || undefined,
          env: userDir ? {
            ...process.env,
            HOME: userDir,
            GNUPGHOME: process.env.GNUPGHOME || `${realHome}/.gnupg`,
            PASSWORD_STORE_DIR: process.env.PASSWORD_STORE_DIR || `${realHome}/.password-store`,
          } : process.env,
        });
        const truncated = output.substring(0, 10000);
        return output.length > 10000 ? truncated + '\n...(truncated)' : truncated;
      }

      case 'memory_search': {
        const results = await memory.search(input.query, {
          limit: input.limit,
          category: input.category,
        });
        return JSON.stringify(results.map(m => ({
          content: m.content,
          category: m.category,
          importance: m.importance,
          created: m.created_at,
          source: m.source,
        })));
      }

      case 'memory_add': {
        const result = await memory.add(input.content, {
          category: input.category || 'fact',
          importance: input.importance || 0.5,
          source: input.source,
        });
        return `Stored memory: ${result.id}`;
      }

      case 'memory_date': {
        const results = await memory.byDate(input.date, { category: input.category });
        return JSON.stringify(results.map(m => ({
          content: m.content,
          category: m.category,
          created: m.created_at,
        })));
      }

      case 'background_task': {
        const { bg, ctx: telegramCtx, claude: claudeInstance } = context;
        if (!bg || !telegramCtx) return 'Background tasks not available in this context.';
        if (!claudeInstance) return 'Background tasks not available.';
        const taskId = bg.spawn(claudeInstance, input.task, telegramCtx, memory, context);
        if (taskId === null) return 'Too many background tasks running. Wait for one to finish.';
        return `Background task #${taskId} spawned. It will send progress updates and the final result to the chat.`;
      }

      case 'vercel_deploy': {
        const token = context.config?.vercel?.token;
        if (!token) return 'Vercel not configured.';
        const dir = userDir ? resolveUserPath(input.directory, userDir) : input.directory;
        const args = ['vercel', '--yes'];
        if (input.production) args.push('--prod');
        if (input.name) {
          const safeName = input.name.replace(/[^a-zA-Z0-9_-]/g, '');
          if (safeName) args.push('--name', safeName);
        }
        const output = execFileSync('npx', args, {
          encoding: 'utf-8',
          timeout: 120000,
          cwd: dir,
          env: { ...process.env, VERCEL_TOKEN: token },
        });
        const truncated = output.substring(0, 5000);
        return output.length > 5000 ? truncated + '\n...(truncated)' : truncated;
      }

      case 'vercel_list': {
        const token = context.config?.vercel?.token;
        if (!token) return 'Vercel not configured.';
        const listArgs = ['vercel', 'ls'];
        if (input.project) {
          const safeProject = input.project.replace(/[^a-zA-Z0-9_\-./]/g, '');
          if (safeProject) listArgs.push(safeProject);
        }
        const output = execFileSync('npx', listArgs, {
          encoding: 'utf-8', timeout: 30000, env: { ...process.env, VERCEL_TOKEN: token },
        });
        return output.substring(0, 5000);
      }

      case 'web_fetch': {
        if (!isAllowedUrl(input.url)) return 'Blocked: URL points to a private/internal address.';
        const jinaUrl = `https://r.jina.ai/${input.url}`;
        const res = await fetch(jinaUrl, {
          headers: { 'Accept': 'text/markdown' },
        });
        if (!res.ok) return `Failed to fetch: HTTP ${res.status}`;
        const text = await res.text();
        return text.substring(0, 15000);
      }

      case 'read_file': {
        const filePath = userDir ? resolveUserPath(input.path, userDir) : input.path;
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const truncatedFile = fileContent.substring(0, 50000);
        return fileContent.length > 50000 ? truncatedFile + '\n...(truncated)' : truncatedFile;
      }

      case 'write_file': {
        const filePath = userDir ? resolveUserPath(input.path, userDir) : input.path;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, input.content);
        return `Written: ${filePath}`;
      }

      case 'store_secret': {
        const credentials = require('./credentials');
        credentials.storeSecret(context.userId, input.key, input.value);
        return `Stored secret: ${input.key}`;
      }

      case 'read_secret': {
        const credentials = require('./credentials');
        const val = credentials.readSecret(context.userId, input.key);
        if (val === null) return `Secret not found: ${input.key}`;
        return val;
      }

      case 'list_secrets': {
        const credentials = require('./credentials');
        const keys = credentials.listSecrets(context.userId);
        if (keys.length === 0) return 'No secrets stored.';
        return keys.join('\n');
      }

      case 'send_file': {
        const filePath = userDir ? resolveUserPath(input.path, userDir) : input.path;
        if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;
        const telegramCtx = context.ctx;
        if (!telegramCtx) return 'Cannot send files in this context.';
        const { InputFile } = require('grammy');
        await telegramCtx.replyWithDocument(new InputFile(filePath), {
          caption: input.caption || undefined,
        });
        return `Sent: ${path.basename(filePath)}`;
      }

      case 'telegram_ask': {
        if (!context.telegramAsk) return 'telegram_ask not available in this context.';
        return await context.telegramAsk(input.message, input.options || [], input.timeout);
      }

      case 'bridge_ask': {
        const { bridgeAsk } = require('./bridge');
        return await bridgeAsk(input.question, context.userId, context.config, context._notifyFn, input.partner_id);
      }

      case 'bridge_tell': {
        const { bridgeTell } = require('./bridge');
        return await bridgeTell(input.message, context.userId, context.config, context._notifyFn, input.partner_id);
      }

      case 'schedule_event': {
        if (!context.scheduler) return 'Scheduler not available (Supabase not configured).';
        const tz = input.timezone || 'UTC';
        const localDate = new Date(input.due_at);
        if (isNaN(localDate.getTime())) return `Invalid date: ${input.due_at}`;
        const utcDate = toUTC(input.due_at, tz);
        const event = await context.scheduler.add(context.chatId, input.title, utcDate, tz, input.description || null);
        const displayTime = new Date(utcDate).toLocaleString('en-US', { timeZone: tz });
        return `Scheduled: "${input.title}" for ${displayTime} (${tz}) — ID: ${event.id}`;
      }

      case 'list_events': {
        if (!context.scheduler) return 'Scheduler not available (Supabase not configured).';
        const events = await context.scheduler.list({ status: input.status });
        if (events.length === 0) return `No ${input.status || 'pending'} events.`;
        return JSON.stringify(events.map(e => ({
          id: e.id,
          title: e.title,
          description: e.description,
          due_at: e.due_at,
          timezone: e.timezone,
          due_local: new Date(e.due_at).toLocaleString('en-US', { timeZone: e.timezone }),
          status: e.status,
        })));
      }

      case 'cancel_event': {
        if (!context.scheduler) return 'Scheduler not available (Supabase not configured).';
        const cancelled = await context.scheduler.cancel(input.event_id);
        if (!cancelled) return `Event not found or not yours: ${input.event_id}`;
        return `Cancelled: "${cancelled.title}"`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function toUTC(dateStr, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const target = new Date(dateStr);
  const utcGuess = new Date(target.toISOString());
  const inTz = new Date(fmt.format(utcGuess));
  const offset = inTz.getTime() - utcGuess.getTime();
  return new Date(target.getTime() - offset).toISOString();
}

function getMaxToolIterations() { return MAX_TOOL_ITERATIONS; }
function setMaxToolIterations(n) { MAX_TOOL_ITERATIONS = n; }

module.exports = { createClaude, createAnthropicClient, getMaxToolIterations, setMaxToolIterations };
