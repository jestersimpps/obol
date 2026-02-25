const definitions = [
  {
    name: 'memory_search',
    description: 'Search vector memory for relevant past context. Use before answering questions about prior conversations, decisions, or facts.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        category: { type: 'string', enum: ['fact', 'preference', 'decision', 'lesson', 'person', 'project', 'event', 'conversation', 'resource', 'pattern', 'context', 'email'], description: 'Filter by category' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_add',
    description: 'Store a new memory. Use to remember facts, decisions, preferences, events.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to remember' },
        category: { type: 'string', enum: ['fact', 'preference', 'decision', 'lesson', 'person', 'project', 'event', 'conversation', 'resource', 'pattern', 'context', 'email'], description: 'Memory category' },
        importance: { type: 'number', description: 'Importance 0-1 (default 0.5)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Keyword tags for filtering (e.g. ["work", "health", "api"])' },
        source: { type: 'string', description: 'Where this came from' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_query',
    description: 'Filter memories by tag, date, category, source, or importance. Use for "what did we do today", "anything tagged X", "all decisions this week".',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date filter: "today", "yesterday", "2026-02-22", "7d"' },
        category: { type: 'string', enum: ['fact', 'preference', 'decision', 'lesson', 'person', 'project', 'event', 'conversation', 'resource', 'pattern', 'context', 'email'], description: 'Filter by category' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (matches any)' },
        source: { type: 'string', description: 'Filter by source (e.g. "turn-extraction", "evolution-3")' },
        minImportance: { type: 'number', description: 'Minimum importance threshold (0-1)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
];

function formatMemory(m) {
  const date = m.created_at ? new Date(m.created_at).toISOString().slice(0, 10) : null;
  const tags = m.tags?.length ? ` #${m.tags.join(' #')}` : '';
  return `[${date || '?'}] [${m.category}] ${m.content}${tags}`;
}

const handlers = {
  async memory_search(input, memory) {
    const results = await memory.search(input.query, {
      limit: input.limit,
      category: input.category,
    });
    return JSON.stringify(results.map(formatMemory));
  },

  async memory_add(input, memory) {
    const result = await memory.add(input.content, {
      category: input.category || 'fact',
      importance: input.importance || 0.5,
      tags: input.tags || [],
      source: input.source,
    });
    return `Stored memory: ${result.id}`;
  },

  async memory_query(input, memory) {
    const results = await memory.query({
      date: input.date,
      category: input.category,
      tags: input.tags,
      source: input.source,
      minImportance: input.minImportance,
      limit: input.limit,
    });
    return JSON.stringify(results.map(formatMemory));
  },
};

const requiresMemory = true;

module.exports = { definitions, handlers, requiresMemory };
