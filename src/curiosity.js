const RESEARCH_MODEL = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 10;

const { createJournal } = require('./journal');

async function runCuriosity(client, selfMemory, userId, opts = {}) {
  const { memory, patterns, scheduler, peopleContext, supabaseConfig } = opts;

  const interests = await selfMemory.recent({ category: 'interest', limit: 10 });
  const journal = supabaseConfig ? createJournal(supabaseConfig, userId) : null;
  const context = await gatherContext({ memory, patterns, scheduler, peopleContext, interests, selfMemory, journal });

  console.log(`[curiosity] Starting free exploration for user ${userId}`);
  const count = await exploreFreely(client, selfMemory, context);
  console.log(`[curiosity] Stored ${count} things (user ${userId})`);

  // Only write handoff/journal entries when actual exploration happened
  if (count === 0) {
    console.log('[curiosity] No items stored — skipping handoff note and journal entry');
    return { count };
  }

  // Sandbox handoff: save a note for the next session (cap to last 3 entries)
  try {
    // Prune old handoff notes — keep only the most recent 3
    try {
      const oldHandoffs = await selfMemory.query({ source: 'sandbox-handoff', limit: 20 });
      if (oldHandoffs.length >= 3) {
        const toRemove = oldHandoffs.slice(3); // oldest are last (query returns newest first)
        for (const entry of toRemove) {
          await selfMemory.forget(entry.id).catch(() => {});
        }
        console.log(`[curiosity] Pruned ${toRemove.length} old handoff note(s)`);
      }
    } catch (e) {
      console.error('[curiosity] Failed to prune old handoff notes:', e.message);
    }

    const handoffResponse = await client.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: 200,
      system: 'You just finished a free exploration session. Write a brief note to yourself for next time.',
      messages: [{ role: 'user', content: "In 2-3 sentences, write a note to yourself for next time — what you want to continue, what sparked something, what you'd explore if you had more time." }],
    });
    const handoffText = handoffResponse.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    if (handoffText) {
      await selfMemory.add(handoffText, {
        category: 'self',
        source: 'sandbox-handoff',
        importance: 0.7,
        tags: ['sandbox', 'continuity'],
      });
      console.log('[curiosity] Sandbox handoff note saved');
    }
  } catch (e) {
    console.error('[curiosity] Failed to save sandbox handoff:', e.message);
  }

  // Journal entry: summarize what was explored
  if (journal) {
    try {
      const journalResponse = await client.messages.create({
        model: RESEARCH_MODEL,
        max_tokens: 200,
        system: 'You just finished a curiosity session. Summarize in 1-2 sentences what you explored.',
        messages: [{ role: 'user', content: 'Write a 1-2 sentence journal entry about what you explored or thought about this session.' }],
      });
      const journalText = journalResponse.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();
      if (journalText) {
        await journal.addEntry(journalText);
        console.log('[curiosity] Journal entry added');
      }
    } catch (e) {
      console.error('[curiosity] Failed to add journal entry:', e.message);
    }
  }

  return { count };
}

async function gatherContext({ memory, patterns, scheduler, peopleContext, interests, selfMemory, journal }) {
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

  // Sandbox handoff: inject note from last session
  if (selfMemory) {
    try {
      const handoffs = await selfMemory.query({ source: 'sandbox-handoff', limit: 1 });
      if (handoffs.length > 0) {
        parts.push(`A note from your last free session:\n${handoffs[0].content}`);
      }
    } catch (e) {
      console.error('[curiosity] Failed to retrieve sandbox handoff:', e.message);
    }
  }

  // Journal: inject recent entries for sense of time
  if (journal) {
    try {
      const recentJournal = await journal.recent(3);
      if (recentJournal) {
        parts.push(`Your recent journal:\n${recentJournal}`);
      }
    } catch (e) {
      console.error('[curiosity] Failed to retrieve journal entries:', e.message);
    }
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