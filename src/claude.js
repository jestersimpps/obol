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

    // Add user message
    history.push({ role: 'user', content: userMessage });

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
          const result = await executeToolCall(block, memory);
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

  return { chat, client };
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

async function executeToolCall(toolUse, memory) {
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
