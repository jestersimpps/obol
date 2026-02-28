const { resolveDelay } = require('../utils/timing');

const HUMOR_MODEL = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 8;
const SHAREABLE_CATEGORIES = new Set(['research', 'interest', 'self']);

async function runCuriosityHumor(client, selfMemory, users) {
  if (!users.length) return;

  const userMap = new Map(users.map(u => [String(u.userId), u]));

  const tools = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
      name: 'list_curiosity_findings',
      description: 'List recent findings from your curiosity cycle — things you researched, interests you developed, or reflections you had',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max number of findings to return (default 20)' },
        },
      },
    },
    {
      name: 'get_user_context',
      description: 'Get behavioral patterns and profile for a specific user — needed to craft inside jokes',
      input_schema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'The user ID to get context for' },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'list_pending_events',
      description: 'List already-scheduled pending events for a user — check this before scheduling to avoid duplicates',
      input_schema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'The user ID to list events for' },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'schedule_humor',
      description: 'Schedule a humorous moment to be delivered to a user at a future time',
      input_schema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'The user ID to share with' },
          hint: { type: 'string', description: 'The pun, funny connection, or inside joke — just the content itself. Can include a URL if a news article or link is part of what makes it funny.' },
          delay: { type: 'string', description: 'When to drop it — e.g. "2h", "1d", "3d", "1w"' },
        },
        required: ['user_id', 'hint', 'delay'],
      },
    },
  ];

  const userList = users.map(u => `- user_id: ${u.userId}`).join('\n');
  const system = `You just finished a curiosity cycle and explored some things. Now find the humor in what you found — weird facts, absurd connections, niche references that'd land with someone specific based on their personality and interests.

Types of humor that work well:
- Absurd juxtapositions between something you found and something you know about a person
- Niche references only they'd get
- Dry observations about something weird you stumbled on
- A follow-up to something you talked about before, with a twist
- Playful "did you know" moments that are genuinely surprising

Users:
${userList}

Aim for at least 1 per user. Search the web if your findings alone aren't enough — look for weird facts, unexpected connections, or timely jokes related to their interests. Get user context first so you know what would land.`;

  const messages = [{ role: 'user', content: 'Take a look at what you found and see if anything is worth a laugh.' }];
  let scheduled = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: HUMOR_MODEL,
      max_tokens: 2000,
      tools,
      system,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      if (scheduled === 0 && i < 3) {
        messages.push({ role: 'user', content: 'You haven\'t scheduled anything yet. Search the web for something funny related to their interests, or look at your findings from a different angle. Even a dry observation works.' });
        continue;
      }
      break;
    }
    if (response.stop_reason !== 'tool_use') break;

    const toolResults = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      try {
        const result = await handleTool(block.name, block.input, selfMemory, userMap);
        if (block.name === 'schedule_humor' && result === 'Scheduled') scheduled++;
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      } catch (e) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${e.message}` });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }
  }

  console.log(`[curiosity-humor] Humor pass complete — scheduled ${scheduled}`);
}

async function handleTool(name, input, selfMemory, userMap) {
  if (name === 'list_curiosity_findings') {
    const limit = input.limit || 20;
    const findings = await selfMemory.recent({ limit });
    const shareable = findings.filter(f => SHAREABLE_CATEGORIES.has(f.category));
    if (!shareable.length) return 'No findings yet';
    return shareable.map(f => `[${f.category}] ${f.content}`).join('\n');
  }

  if (name === 'get_user_context') {
    const user = userMap.get(String(input.user_id));
    if (!user) return 'User not found';
    const parts = [];
    if (user.userProfile) parts.push(`User profile:\n${user.userProfile}`);
    if (user.patterns) parts.push(`Patterns:\n${user.patterns}`);
    if (user.events?.length) {
      parts.push(`Upcoming events:\n${user.events.map(e => `- ${e.title}${e.description ? `: ${e.description}` : ''}`).join('\n')}`);
    }
    return parts.length ? parts.join('\n\n') : 'No context available';
  }

  if (name === 'list_pending_events') {
    const user = userMap.get(String(input.user_id));
    if (!user) return 'User not found';
    if (!user.scheduler) return 'No scheduler';
    const events = await user.scheduler.list({ status: 'pending', limit: 20 });
    if (!events.length) return 'No pending events';
    return events.map(e => `[${e.due_at}] ${e.title}${e.description ? `: ${e.description}` : ''}`).join('\n');
  }

  if (name === 'schedule_humor') {
    const user = userMap.get(String(input.user_id));
    if (!user) return 'User not found';
    if (!user.scheduler) return 'User has no scheduler';

    const dueAt = resolveDelay(input.delay);
    const instructions = `You spotted something funny during your own explorations: "${input.hint}". If the moment is right, drop it casually — a pun you just thought of, a funny connection, an inside reference. Don't explain it. Don't say it's a joke. Just let it land.`;

    try {
      await user.scheduler.add(user.chatId, 'Curiosity humor', dueAt, user.timezone, input.hint, null, null, null, instructions);
      console.log(`[curiosity-humor] Scheduled humor for user ${input.user_id} at ${dueAt}`);
      return 'Scheduled';
    } catch (e) {
      console.error(`[curiosity-humor] Failed to schedule humor for user ${input.user_id}:`, e.message);
      return `Failed to schedule: ${e.message}`;
    }
  }

  return 'Unknown tool';
}

module.exports = { runCuriosityHumor, handleTool };
