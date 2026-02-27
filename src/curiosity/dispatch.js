const { resolveDelay } = require('../utils/timing');

const DISPATCH_MODEL = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 10;
const SHAREABLE_CATEGORIES = new Set(['research', 'interest', 'self']);

async function runCuriosityDispatch(client, selfMemory, users) {
  if (!users.length) return;

  const userMap = new Map(users.map(u => [String(u.userId), u]));

  const tools = [
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
      description: 'Get behavioral patterns and upcoming events for a specific user',
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
      name: 'schedule_insight',
      description: 'Schedule a curiosity insight to be shared with a user at a future time',
      input_schema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'The user ID to share with' },
          hint: { type: 'string', description: 'The insight or finding to share, in your own words' },
          delay: { type: 'string', description: 'When to share it — e.g. "2h", "1d", "3d", "1w"' },
        },
        required: ['user_id', 'hint', 'delay'],
      },
    },
  ];

  const userList = users.map(u => `- user_id: ${u.userId}`).join('\n');
  const system = `You just finished a curiosity cycle and learned some things. You talk to a set of people:\n${userList}\n\nDecide if any finding is worth sharing with any of them — only if it's genuinely relevant to their patterns, interests, or life context. Use their behavioral patterns and comfort with interaction to decide how much to share. You can share nothing with nobody, or multiple things with multiple people — it's your call.`;

  const messages = [{ role: 'user', content: 'Take a look at what you found and decide if anything is worth passing along.' }];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: DISPATCH_MODEL,
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

      try {
        const result = await handleTool(block.name, block.input, selfMemory, userMap);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      } catch (e) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${e.message}` });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }
  }

  console.log('[curiosity-dispatch] Dispatch pass complete');
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

  if (name === 'schedule_insight') {
    const user = userMap.get(String(input.user_id));
    if (!user) return 'User not found';
    if (!user.scheduler) return 'User has no scheduler';

    const dueAt = resolveDelay(input.delay);
    const instructions = `You came across something during your own free exploration: "${input.hint}". If it feels relevant and the moment is right, bring it up naturally — like you just thought of it. Keep it casual. Don't reference any system.`;

    try {
      await user.scheduler.add(user.chatId, 'Curiosity insight', dueAt, user.timezone, input.hint, null, null, null, instructions);
      console.log(`[curiosity-dispatch] Scheduled insight for user ${input.user_id} at ${dueAt}`);
      return 'Scheduled';
    } catch (e) {
      console.error(`[curiosity-dispatch] Failed to schedule insight for user ${input.user_id}:`, e.message);
      return `Failed to schedule: ${e.message}`;
    }
  }

  return 'Unknown tool';
}

module.exports = { runCuriosityDispatch };
