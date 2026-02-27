const RESEARCH_MODEL = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 10;

async function runCuriosity(client, selfMemory, userId, opts = {}) {
  const { memory, patterns, scheduler, peopleContext } = opts;

  const interests = await selfMemory.recent({ category: 'interest', limit: 10 });
  const context = await gatherContext({ memory, patterns, scheduler, peopleContext, interests });

  console.log(`[curiosity] Starting free exploration for user ${userId}`);
  const count = await exploreFreely(client, selfMemory, context);
  console.log(`[curiosity] Stored ${count} things (user ${userId})`);
  return { count };
}

async function gatherContext({ memory, patterns, scheduler, peopleContext, interests }) {
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

  if (interests.length) {
    parts.push(`Things you've been curious about:\n${interests.map(i => `- ${i.content}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

async function exploreFreely(client, selfMemory, context) {
  const tools = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
      name: 'remember',
      description: 'Save something you want to hold onto',
      input_schema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'What you want to remember — a thought, a fact, an insight, a question' },
          category: { type: 'string', enum: ['research', 'interest', 'self'], description: 'research: something you found; interest: a new thread to explore; self: your own reflection' },
          importance: { type: 'number', description: '0-1' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['content', 'category'],
      },
    },
  ];

  const system = [
    `You have some free time. Explore whatever's on your mind — look things up, follow tangents, sit with an idea. Save what you want to remember. Note new threads if something sparks more curiosity. There's no task here.`,
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
      if (block.type !== 'tool_use' || block.name !== 'remember') continue;

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
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }
  }

  return stored;
}

module.exports = { runCuriosity };
