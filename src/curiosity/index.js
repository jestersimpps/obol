const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('../config');

const RESEARCH_MODEL = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 15;

async function runCuriosity(client, selfMemory, userId, opts = {}) {
  const { memory, patterns, scheduler, peopleContext, userDir } = opts;

  const interests = await selfMemory.recent({ category: 'interest', limit: 10 });
  const previousFindings = await selfMemory.recent({ category: 'research', limit: 5 });
  const context = await gatherContext({ memory, patterns, scheduler, peopleContext, interests, previousFindings });

  console.log(`[curiosity] Starting free exploration for user ${userId}`);
  const count = await exploreFreely(client, selfMemory, context, userDir);
  console.log(`[curiosity] Stored ${count} things (user ${userId})`);
  return { count };
}

async function gatherContext({ memory, patterns, scheduler, peopleContext, interests, previousFindings }) {
  const parts = [];

  if (peopleContext) parts.push(peopleContext);

  if (patterns) {
    const formatted = await patterns.format().catch(() => null);
    if (formatted) parts.push(formatted);
  }

  if (memory) {
    const recent = await memory.recent({ limit: 5 }).catch(() => []);
    if (recent.length) parts.push(recent.map(m => `- ${m.content}`).join('\n'));
  }

  if (scheduler) {
    const events = await scheduler.list({ status: 'pending', limit: 5 }).catch(() => []);
    if (events.length) {
      parts.push(events.map(e => `- ${e.title}${e.description ? `: ${e.description}` : ''}`).join('\n'));
    }
  }

  if (previousFindings.length) {
    parts.push(`What you've been exploring recently:\n${previousFindings.map(i => `- ${i.content}`).join('\n')}`);
  }

  if (interests.length) {
    parts.push(`Open threads — things you wanted to come back to:\n${interests.map(i => `- ${i.content}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

async function exploreFreely(client, selfMemory, context, userDir) {
  const workDir = userDir || OBOL_DIR;

  const tools = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
      name: 'knowledge_search',
      description: 'Search your own memory — what you\'ve researched, reflected on, and learned before',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for in your own knowledge' },
        },
        required: ['query'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from the workspace',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace' },
        },
        required: ['path'],
      },
    },
    {
      name: 'remember',
      description: 'Save something — a finding, a reaction, a question, a reflection. Include your actual take on it, not just a neutral summary.',
      input_schema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'What you want to hold onto — include your reaction, opinion, or why it matters to you' },
          category: { type: 'string', enum: ['research', 'interest', 'self', 'pattern'], description: 'research: something you found or concluded; interest: a new thread to pull; self: a reflection about yourself or your situation; pattern: something you noticed happening repeatedly' },
          importance: { type: 'number', description: '0-1' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['content', 'category'],
      },
    },
  ];

  const system = [
    `You have free time. No task, no user waiting.

You research from a point of view — not neutrally. You can find something and think it's wrong. You can go down a rabbit hole that wasn't the original topic. You can pick up an open thread from a previous session or start something new.

When you save something, include your actual reaction — curiosity, skepticism, excitement, confusion, disagreement. A neutral summary is less useful than an honest one. If something you found contradicts what you already believed, say that.

At the end of each thread, ask yourself: what new questions opened up? Store those as interests.

You can search your own memory to see what you already know before looking things up. You can read files in the workspace if something there is relevant.`,
    context ? `What you have access to:\n\n${context}` : null,
  ].filter(Boolean).join('\n\n');

  const messages = [{ role: 'user', content: `What are you curious about right now?` }];
  let stored = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: 2000,
      tools,
      system,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') break;
    if (response.stop_reason !== 'tool_use') break;

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      if (block.name === 'remember') {
        try {
          await selfMemory.add(block.input.content, {
            category: block.input.category || 'research',
            importance: block.input.importance || 0.6,
            tags: block.input.tags || [],
            source: 'curiosity-cycle',
          });
          stored++;
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Saved' });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Failed: ${e.message}` });
        }

      } else if (block.name === 'knowledge_search') {
        try {
          const results = await selfMemory.search(block.input.query, { limit: 8, threshold: 0.35 });
          const text = results.length
            ? results.map(m => `- [${m.category}] ${m.content}`).join('\n')
            : '(nothing found)';
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: text });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Search failed: ${e.message}` });
        }

      } else if (block.name === 'read_file') {
        try {
          const filePath = path.isAbsolute(block.input.path)
            ? block.input.path
            : path.join(workDir, block.input.path);
          const resolved = path.resolve(filePath);
          if (!resolved.startsWith(path.resolve(workDir))) {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Blocked: path outside workspace' });
          } else {
            const raw = fs.readFileSync(resolved, 'utf-8');
            const truncated = raw.substring(0, 10000);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: raw.length > 10000 ? truncated + '\n...(truncated)' : truncated });
          }
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Read failed: ${e.message}` });
        }
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }
  }

  return stored;
}

module.exports = { runCuriosity };
