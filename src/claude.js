const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { refreshTokens, isExpired, isOAuthToken } = require('./oauth');
const { saveConfig, loadConfig } = require('./config');

const MAX_EXEC_TIMEOUT = 120;

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
];

function createAnthropicClient(anthropicConfig, { useOAuth = true } = {}) {
  if (useOAuth && anthropicConfig.oauth) {
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

async function ensureFreshToken(anthropicConfig) {
  if (!anthropicConfig.oauth) return;
  if (!isExpired(anthropicConfig.oauth)) return;

  try {
    const tokens = await refreshTokens(anthropicConfig.oauth.refreshToken);
    anthropicConfig.oauth.accessToken = tokens.accessToken;
    anthropicConfig.oauth.refreshToken = tokens.refreshToken;
    anthropicConfig.oauth.expires = tokens.expires;

    const config = loadConfig({ resolve: false });
    if (config) {
      config.anthropic.oauth = anthropicConfig.oauth;
      saveConfig(config);
    }
  } catch (e) {
    if (anthropicConfig.apiKey) {
      console.warn('[oauth] Token refresh failed, falling back to API key:', e.message);
      anthropicConfig._oauthFailed = true;
    } else {
      throw e;
    }
  }
}

function createClaude(anthropicConfig, { personality, memory, userDir, bridgeEnabled }) {
  let client = createAnthropicClient(anthropicConfig);
  const useOAuth = !!anthropicConfig.oauth;

  const baseSystemPrompt = buildSystemPrompt(personality, userDir, { bridgeEnabled });

  const histories = new Map();
  const MAX_HISTORY = 50;

  const tools = buildTools(memory, { bridgeEnabled });

  async function chat(userMessage, context = {}) {
    context.userDir = userDir;
    const chatId = context.chatId || 'default';

    if (useOAuth) {
      await ensureFreshToken(anthropicConfig);
      client = createAnthropicClient(anthropicConfig, { useOAuth: !anthropicConfig._oauthFailed });
    }

    // Get or create history
    if (!histories.has(chatId)) histories.set(chatId, []);
    const history = histories.get(chatId);

    // Ask Haiku if we need memory for this message
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
        const decision = JSON.parse(decisionText.match(/\{[\s\S]*\}/)?.[0] || '{}');

        // Set model based on Haiku's decision
        if (decision.model === 'opus') {
          context._model = 'claude-opus-4-6';
        }

        if (decision.need_memory) {
          const query = decision.search_query || userMessage;

          // Today's context + semantic search
          const todayMemories = await memory.byDate('today', { limit: 3 });
          const semanticMemories = await memory.search(query, { limit: 3, threshold: 0.5 });

          // Dedupe by ID
          const seen = new Set();
          const combined = [];
          for (const m of [...todayMemories, ...semanticMemories]) {
            if (!seen.has(m.id)) {
              seen.add(m.id);
              combined.push(m);
            }
          }

          if (combined.length > 0) {
            memoryContext = '\n\n[Relevant memories]\n' +
              combined.map(m => `- [${m.category}] ${m.content}`).join('\n');
          }
        }
      } catch (e) {
        console.error('[router] Memory/routing decision failed:', e.message);
      }
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

    // Trim history if too long
    while (history.length > MAX_HISTORY) history.shift();

    // Call Claude — Haiku picks the model
    const model = context._model || 'claude-sonnet-4-6';
    const systemPrompt = baseSystemPrompt + `\nCurrent time: ${new Date().toISOString()}`;
    let response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: history,
      tools: tools.length > 0 ? tools : undefined,
    });

    // Handle tool use loop
    while (response.stop_reason === 'tool_use') {
      const assistantContent = response.content;
      history.push({ role: 'assistant', content: assistantContent });

      const toolResults = [];
      for (const block of assistantContent) {
        if (block.type === 'tool_use') {
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

    // Extract text response
    const textBlocks = response.content.filter(b => b.type === 'text');
    const replyText = textBlocks.map(b => b.text).join('\n');

    // Add assistant response to history
    history.push({ role: 'assistant', content: response.content });

    return replyText;
  }

  function reloadPersonality() {
    const pDir = userDir ? path.join(userDir, 'personality') : undefined;
    const newPersonality = require('./personality').loadPersonality(pDir);
    for (const key of Object.keys(personality)) delete personality[key];
    Object.assign(personality, newPersonality);
  }

  function clearHistory(chatId) {
    if (chatId) {
      histories.delete(chatId);
    } else {
      histories.clear();
    }
  }

  return { chat, client, reloadPersonality, clearHistory };
}

function buildSystemPrompt(personality, userDir, opts = {}) {
  const parts = ['You are an AI assistant powered by OBOL.'];

  if (personality.soul) parts.push(`\n## Personality\n${personality.soul}`);
  if (personality.user) parts.push(`\n## About Your Owner\n${personality.user}`);
  if (personality.agents) parts.push(`\n## Operating Instructions\n${personality.agents}`);

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

## Secrets (pass)

When storing secrets with \`pass\`, ALWAYS use the prefix \`${passPrefix}/\`.
Example: \`pass insert ${passPrefix}/gmail-key\`
Shared bot credentials (Anthropic, Telegram, Supabase) live under \`obol/\` — do NOT touch those.
`);

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

  if (opts.bridgeEnabled) {
    const { buildBridgeTool, buildBridgeTellTool } = require('./bridge');
    tools.push(buildBridgeTool());
    tools.push(buildBridgeTellTool());
  }

  return tools;
}

function resolveUserPath(inputPath, userDir) {
  if (!userDir) return inputPath;
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(userDir, inputPath);
  const normalizedUser = path.resolve(userDir);

  let realResolved = resolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      realResolved = path.join(realParent, path.basename(resolved));
    } catch {}
  }

  if (!realResolved.startsWith(normalizedUser + path.sep) && realResolved !== normalizedUser) {
    if (realResolved.startsWith('/tmp')) return realResolved;
    throw new Error(`Path "${inputPath}" is outside your workspace. Use paths relative to your workspace or /tmp.`);
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
        const timeout = Math.min(input.timeout || 30, MAX_EXEC_TIMEOUT) * 1000;
        const output = execSync(input.command, {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: userDir || undefined,
        });
        return output.substring(0, 10000);
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
        return `Background task #${taskId} spawned. It will send progress updates and the final result to the chat.`;
      }

      case 'vercel_deploy': {
        const token = context.config?.vercel?.token;
        if (!token) return 'Vercel not configured.';
        const dir = userDir ? resolveUserPath(input.directory, userDir) : input.directory;
        const prod = input.production ? '--prod' : '';
        const safeName = input.name ? input.name.replace(/[^a-zA-Z0-9_-]/g, '') : '';
        const projName = safeName ? `--name "${safeName}"` : '';
        const output = execSync(
          `cd "${dir}" && npx vercel ${prod} ${projName} --yes 2>&1`,
          { encoding: 'utf-8', timeout: 120000, env: { ...process.env, VERCEL_TOKEN: token } }
        );
        return output.substring(0, 5000);
      }

      case 'vercel_list': {
        const token = context.config?.vercel?.token;
        if (!token) return 'Vercel not configured.';
        const output = execSync(
          `npx vercel ls ${input.project} 2>&1`,
          { encoding: 'utf-8', timeout: 30000, env: { ...process.env, VERCEL_TOKEN: token } }
        );
        return output.substring(0, 5000);
      }

      case 'web_fetch': {
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
        return fs.readFileSync(filePath, 'utf-8').substring(0, 50000);
      }

      case 'write_file': {
        const filePath = userDir ? resolveUserPath(input.path, userDir) : input.path;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, input.content);
        return `Written: ${filePath}`;
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
