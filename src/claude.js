const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { refreshTokens, isExpired, isOAuthToken } = require('./oauth');
const { saveConfig, loadConfig, OBOL_DIR } = require('./config');
const { execAsync, isAllowedUrl } = require('./sanitize');

const MAX_EXEC_TIMEOUT = 120;
const MAX_TOOL_ITERATIONS = 15;

const BLOCKED_EXEC_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive)\b/,
  /\bshutdown\b/, /\breboot\b/, /\bpoweroff\b/,
  /\bmkfs\b/, /\bdd\s+if=/, /\b:()\{\s*:|:&\s*\};:/,
  /\bchmod\s+(-R\s+)?[0-7]*\s+\/[^t]/,
  />\s*\/etc\//, />\s*\/boot\//,
  /\beval\s+/, /\bsource\s+/,
  /\bbash\s+-c\b/, /\bsh\s+-c\b/, /\bzsh\s+-c\b/,
  /`[^`]*`/,
  /\$\([^)]*\)/,
  /\bpython[23]?\s+-c\b/, /\bperl\s+-e\b/, /\bruby\s+-e\b/, /\bnode\s+-e\b/,
  /\bcurl\b.*\|\s*(ba)?sh/, /\bwget\b.*\|\s*(ba)?sh/,
  /\benv\b.*\b(sh|bash|zsh)\b/,
  /\bfind\b.*-exec\b/,
  /\bprintf\b.*\|\s*(ba)?sh/,
  /\\x[0-9a-fA-F]{2}/, /\\[0-7]{3}/,
  /\bnc\s+-e\b/, /\bncat\b.*-e\b/,
  /\bmkfifo\b/,
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

  const histories = new Map();
  const MAX_HISTORY = 50;

  const tools = buildTools(memory, { bridgeEnabled });

  async function chat(userMessage, context = {}) {
    context.userDir = userDir;
    const chatId = context.chatId || 'default';

    if (anthropicConfig.oauth?.accessToken) {
      await ensureFreshToken(anthropicConfig);
      if (anthropicConfig._oauthFailed) {
        client = createAnthropicClient(anthropicConfig, { useOAuth: false });
      } else {
        client = createAnthropicClient(anthropicConfig, { useOAuth: true });
      }
    }

    // Get or create history
    if (!histories.has(chatId)) histories.set(chatId, []);
    const history = histories.get(chatId);

    const verbose = context.verbose || false;
    if (verbose) context.verboseLog = [];
    const vlog = (msg) => { if (verbose) context.verboseLog.push(msg); };

    let memoryContext = '';
    if (memory) {
      try {
        const memoryDecision = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 100,
          system: `You are a router. Analyze this user message and decide two things:

1. Does it need memory context? (past conversations, facts, preferences, people, events)
2. What model complexity does it need?

Reply with ONLY a JSON object:
{"need_memory": true/false, "search_query": "optimized search query", "model": "sonnet|opus"}

Memory: casual messages (greetings, jokes, simple questions) → false. References to past, people, projects, preferences → true with optimized search query.

Model: Use "sonnet" for most things (chat, simple questions, quick tasks, single-step work). Use "opus" ONLY for: complex multi-step research, architecture/design decisions, long-form writing, deep analysis, debugging complex code, tasks requiring exceptional reasoning.`,
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

    while (history.length >= MAX_HISTORY) {
      history.shift();
      history.shift();
    }
    while (history.length > 0) {
      const first = history[0];
      if (first.role !== 'user') {
        history.shift();
        continue;
      }
      if (Array.isArray(first.content) && first.content.some(b => b.type === 'tool_result')) {
        history.shift();
        continue;
      }
      break;
    }

    // Add user message with memory context
    const enrichedMessage = memoryContext
      ? userMessage + memoryContext
      : userMessage;
    if (context.images?.length) {
      history.push({
        role: 'user',
        content: [...context.images, { type: 'text', text: enrichedMessage }],
      });
    } else {
      history.push({ role: 'user', content: enrichedMessage });
    }

    const model = context._model || 'claude-sonnet-4-6';
    vlog(`[model] ${model} | history=${history.length} msgs`);
    const systemPrompt = baseSystemPrompt + `\nCurrent time: ${new Date().toISOString()}`;
    let response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: history,
      tools: tools.length > 0 ? tools : undefined,
    });

    let toolIterations = 0;
    while (response.stop_reason === 'tool_use') {
      toolIterations++;
      if (toolIterations > MAX_TOOL_ITERATIONS) {
        history.push({ role: 'assistant', content: response.content });
        history.push({ role: 'user', content: 'You have used too many tool calls. Please provide a final response now based on what you have so far.' });
        response = await client.messages.create({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: history,
        });
        break;
      }

      const assistantContent = response.content;
      history.push({ role: 'assistant', content: assistantContent });

      const toolResults = [];
      for (const block of assistantContent) {
        if (block.type === 'tool_use') {
          const inputSummary = block.name === 'exec' ? block.input.command :
            block.name === 'write_file' ? block.input.path :
            block.name === 'read_file' ? block.input.path :
            block.name === 'memory_search' ? block.input.query :
            block.name === 'memory_add' ? `[${block.input.category || 'fact'}]` :
            block.name === 'web_fetch' ? block.input.url :
            block.name === 'background_task' ? block.input.task?.substring(0, 60) :
            JSON.stringify(block.input).substring(0, 80);
          vlog(`[tool] ${block.name}: ${inputSummary}`);
          const result = await executeToolCall(block, memory, context);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      history.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: history,
        tools,
      });
    }

    const textBlocks = response.content.filter(b => b.type === 'text');
    const replyText = textBlocks.map(b => b.text).join('\n');

    if (response.usage) {
      vlog(`[tokens] in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);
    }

    history.push({ role: 'assistant', content: response.content });

    return replyText;
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
    if (!histories.has(chatId)) histories.set(chatId, []);
    const history = histories.get(chatId);
    history.push({ role, content });
  }

  return { chat, client, reloadPersonality, clearHistory, injectHistory };
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

  if (opts.bridgeEnabled) {
    const { buildBridgeTool, buildBridgeTellTool } = require('./bridge');
    tools.push(buildBridgeTool());
    tools.push(buildBridgeTellTool());
  }

  return tools;
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
        const taskId = bg.spawn(claudeInstance, input.task, telegramCtx, memory);
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

      case 'bridge_ask': {
        const { bridgeAsk } = require('./bridge');
        return await bridgeAsk(input.question, context.userId, context.config, context._notifyFn, input.partner_id);
      }

      case 'bridge_tell': {
        const { bridgeTell } = require('./bridge');
        return await bridgeTell(input.message, context.userId, context.config, context._notifyFn, input.partner_id);
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

module.exports = { createClaude, createAnthropicClient };
