const definitions = [
  {
    name: 'knowledge_add',
    description: 'Store something in your own brain — a research finding, a reflection, or something you noticed about this person\'s patterns. This is your memory, not the user\'s.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to store' },
        category: { type: 'string', enum: ['research', 'interest', 'self', 'pattern'], description: 'research: findings from curiosity; interest: topics you want to explore; self: your own reflections/mood/thoughts; pattern: observed patterns about this user' },
        importance: { type: 'number', description: 'Importance 0-1 (default 0.5)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Keyword tags' },
        source: { type: 'string', description: 'Where this came from (e.g. "curiosity-cycle", "conversation")' },
      },
      required: ['content', 'category'],
    },
  },
  {
    name: 'knowledge_search',
    description: 'Search your own knowledge — what you\'ve researched, what you\'re curious about, your own reflections.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        category: { type: 'string', enum: ['research', 'interest', 'self', 'pattern'], description: 'Filter by category' },
      },
      required: ['query'],
    },
  },
  {
    name: 'interests_list',
    description: 'List what you\'re currently curious about.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'interests_add',
    description: 'Add a new interest — something you want to explore in a future curiosity cycle.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The interest or question you want to explore' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Keyword tags' },
      },
      required: ['content'],
    },
  },
];

function formatEntry(m) {
  const date = m.created_at ? new Date(m.created_at).toISOString().slice(0, 10) : null;
  const tags = m.tags?.length ? ` #${m.tags.join(' #')}` : '';
  return `[id:${m.id}] [${date || '?'}] [${m.category}] ${m.content}${tags}`;
}

const handlers = {
  async knowledge_add(input, _memory, context) {
    const selfMemory = context.selfMemory;
    if (!selfMemory) return 'Self memory not available.';
    const result = await selfMemory.add(input.content, {
      category: input.category,
      importance: input.importance || 0.5,
      tags: input.tags || [],
      source: input.source,
    });
    return `Stored: ${result.id}`;
  },

  async knowledge_search(input, _memory, context) {
    const selfMemory = context.selfMemory;
    if (!selfMemory) return 'Self memory not available.';
    const results = await selfMemory.search(input.query, {
      limit: input.limit,
      category: input.category,
    });
    if (!results.length) return 'Nothing found.';
    return JSON.stringify(results.map(formatEntry));
  },

  async interests_list(_input, _memory, context) {
    const selfMemory = context.selfMemory;
    if (!selfMemory) return 'Self memory not available.';
    const results = await selfMemory.recent({ category: 'interest', limit: _input?.limit || 20 });
    if (!results.length) return 'No interests stored yet.';
    return JSON.stringify(results.map(formatEntry));
  },

  async interests_add(input, _memory, context) {
    const selfMemory = context.selfMemory;
    if (!selfMemory) return 'Self memory not available.';
    const result = await selfMemory.add(input.content, {
      category: 'interest',
      importance: 0.6,
      tags: input.tags || [],
      source: 'conversation',
    });
    return `Interest stored: ${result.id}`;
  },
};

const requiresSelfMemory = true;

module.exports = { definitions, handlers, requiresSelfMemory };
