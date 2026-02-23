const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { OBOL_DIR } = require('./config');

function createClaude(anthropicConfig, { personality, memory }) {
  const client = new Anthropic({ apiKey: anthropicConfig.apiKey });

  // Build system prompt from personality files
  const systemPrompt = buildSystemPrompt(personality);

  // Conversation history per chat (in-memory, resets on restart)
  const histories = new Map();
  const MAX_HISTORY = 50;

  // Define tools
  const tools = buildTools(memory);

  async function chat(userMessage, context = {}) {
    const chatId = context.chatId || 'default';

    // Get or create history
    if (!histories.has(chatId)) histories.set(chatId, []);
    const history = histories.get(chatId);

    // Auto-search memory for context before every message
    let memoryContext = '';
    if (memory) {
      try {
        const results = await memory.search(userMessage, { limit: 5, threshold: 0.4 });
        if (results.length > 0) {
          memoryContext = '\n\n[Relevant memories]\n' +
            results.map(m => `- [${m.category}] ${m.content}`).join('\n');
        }
      } catch {}
    }

    // Add user message with memory context
    const enrichedMessage = memoryContext
      ? userMessage + memoryContext
      : userMessage;
    history.push({ role: 'user', content: enrichedMessage });

    // Trim history if too long
    while (history.length > MAX_HISTORY) history.shift();

    // Call Claude
    let response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
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
        model: 'claude-sonnet-4-20250514',
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
    const newPersonality = require('./personality').loadPersonality();
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

function buildSystemPrompt(personality) {
  const parts = ['You are an AI assistant powered by OBOL.'];

  if (personality.soul) parts.push(`\n## Personality\n${personality.soul}`);
  if (personality.user) parts.push(`\n## About Your Owner\n${personality.user}`);
  if (personality.agents) parts.push(`\n## Operating Instructions\n${personality.agents}`);

  parts.push(`\nCurrent time: ${new Date().toISOString()}`);

  return parts.join('\n');
}

function buildTools(memory) {
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
          category: { type: 'string', enum: ['fact', 'preference', 'decision', 'lesson', 'person', 'project', 'event', 'conversation', 'resource', 'pattern', 'context'], description: 'Memory category' },
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

  return tools;
}

async function executeToolCall(toolUse, memory, context = {}) {
  const { name, input } = toolUse;

  try {
    switch (name) {
      case 'exec': {
        const timeout = (input.timeout || 30) * 1000;
        const output = execSync(input.command, {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
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
        const { bg, ctx: telegramCtx } = context;
        if (!bg || !telegramCtx) return 'Background tasks not available in this context.';
        const claudeInstance = { chat, client, reloadPersonality };
        const taskId = bg.spawn(claudeInstance, input.task, telegramCtx, memory);
        return `Background task #${taskId} spawned. It will send progress updates and the final result to the chat.`;
      }

      case 'vercel_deploy': {
        const { loadConfig } = require('./config');
        const cfg = loadConfig();
        const token = cfg?.vercel?.token;
        if (!token) return 'Vercel not configured.';
        const dir = input.directory;
        const prod = input.production ? '--prod' : '';
        const name = input.name ? `--name ${input.name}` : '';
        const output = execSync(
          `cd ${dir} && npx vercel ${prod} ${name} --token ${token} --yes 2>&1`,
          { encoding: 'utf-8', timeout: 120000 }
        );
        return output.substring(0, 5000);
      }

      case 'vercel_list': {
        const { loadConfig } = require('./config');
        const cfg = loadConfig();
        const token = cfg?.vercel?.token;
        if (!token) return 'Vercel not configured.';
        const output = execSync(
          `npx vercel ls ${input.project} --token ${token} 2>&1`,
          { encoding: 'utf-8', timeout: 30000 }
        );
        return output.substring(0, 5000);
      }

      case 'web_fetch': {
        const res = await fetch(input.url);
        const text = await res.text();
        // Basic HTML stripping
        const clean = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 10000);
        return clean;
      }

      case 'read_file': {
        return fs.readFileSync(input.path, 'utf-8').substring(0, 50000);
      }

      case 'write_file': {
        fs.mkdirSync(path.dirname(input.path), { recursive: true });
        fs.writeFileSync(input.path, input.content);
        return `Written: ${input.path}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

module.exports = { createClaude };
