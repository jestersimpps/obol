const Anthropic = require('@anthropic-ai/sdk');
const { createSelfMemory } = require('../memory/self');
const { getTenant } = require('../tenant');
const { getUserTimezone } = require('../config');

const IMPULSE_MODEL = 'claude-haiku-4-5-20251001';
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 300_000;

/** @type {Map<number, number>} */
const _cooldowns = new Map();

/** @type {ReturnType<typeof createSelfMemory> | null} */
let _globalSelfMemory = null;

async function getGlobalSelfMemory(supabaseConfig) {
  if (!_globalSelfMemory) {
    _globalSelfMemory = await createSelfMemory(supabaseConfig, 0);
  }
  return _globalSelfMemory;
}

function isOnCooldown(userId) {
  const last = _cooldowns.get(userId);
  return last && (Date.now() - last) < COOLDOWN_MS;
}

function getTimeContext(timezone) {
  return new Date().toLocaleString('en-US', {
    timeZone: timezone || 'UTC',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

async function gatherContext(tenant, supabaseConfig, opts = {}) {
  const parts = [];

  parts.push(`Time: ${getTimeContext(opts.timezone)} (${opts.timezone || 'UTC'})`);

  const [patterns, userMemories, selfFacts, globalFindings] = await Promise.all([
    tenant.patterns?.format().catch(() => null),
    tenant.memory?.recent({ limit: 5 }).catch(() => []),
    tenant.selfMemory?.recent({ limit: 3 }).catch(() => []),
    supabaseConfig ? getGlobalSelfMemory(supabaseConfig).then(sm => sm.recent({ limit: 5 })).catch(() => []) : [],
  ]);

  if (patterns) parts.push(`Patterns:\n${patterns}`);
  if (userMemories?.length) parts.push(`What you know about them:\n${userMemories.map(m => `- ${m.content}`).join('\n')}`);
  if (selfFacts?.length) parts.push(`Your notes about this relationship:\n${selfFacts.map(m => `- ${m.content}`).join('\n')}`);
  if (globalFindings?.length) parts.push(`Your recent explorations:\n${globalFindings.map(m => `- ${m.content}`).join('\n')}`);

  if (!opts.periodic && opts.lastUserMsg) {
    const userSnip = opts.lastUserMsg.substring(0, 500);
    const assistantSnip = opts.lastAssistantMsg?.substring(0, 500) || '';
    parts.push(`Last exchange:\nThem: ${userSnip}\nYou: ${assistantSnip}`);
  }

  return { text: parts.join('\n\n'), hasSubstance: (globalFindings?.length > 0 || userMemories?.length > 0) };
}

async function checkImpulse(client, context) {
  const response = await client.messages.create({
    model: IMPULSE_MODEL,
    max_tokens: 300,
    system: `You know someone. Here's what's on your mind and what you know about them.
Decide if you have something genuine to say — a check-in about something in their life,
a thought from your own exploration, an observation you connected.
Most of the time: no. Only when it would feel natural and welcome.
Don't follow up on the conversation that just happened — that's not your job here.`,
    messages: [{ role: 'user', content: context }],
    tool_choice: { type: 'tool', name: 'impulse' },
    tools: [{
      name: 'impulse',
      description: 'Decide whether to send a spontaneous message',
      input_schema: {
        type: 'object',
        properties: {
          act: { type: 'boolean', description: 'true if you have something genuine to say' },
          thought: { type: 'string', description: 'The message to send, if acting' },
          kind: { type: 'string', enum: ['curiosity', 'checkin', 'observation'] },
        },
        required: ['act'],
      },
    }],
  });

  const toolUse = response.content.find(b => b.type === 'tool_use');
  return toolUse?.input || { act: false };
}

function sendImpulse(bot, chatId, thought, kind, userId) {
  const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  setTimeout(() => {
    bot.api.sendMessage(chatId, thought).catch(() =>
      bot.api.sendMessage(chatId, thought, { parse_mode: undefined }).catch(() => {})
    );
    console.log(`[impulse] Sent ${kind} to user ${userId}`);
  }, delay);
}

async function maybeImpulse(bot, config, tenant, chatId, lastUserMsg, lastAssistantMsg) {
  const userId = tenant.userId;
  if (isOnCooldown(userId)) return;
  if (!config.supabase) return;

  const { text: context, hasSubstance } = await gatherContext(tenant, config.supabase, {
    lastUserMsg,
    lastAssistantMsg,
    timezone: getUserTimezone(config, tenant.userId),
  });
  if (!hasSubstance) return;

  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const result = await checkImpulse(client, context);

  if (!result.act || !result.thought) return;

  _cooldowns.set(userId, Date.now());
  sendImpulse(bot, chatId, result.thought, result.kind || 'observation', userId);
}

async function maybePeriodicImpulse(bot, config, userId) {
  if (isOnCooldown(userId)) return;
  if (!config.supabase) return;

  const tenant = await getTenant(userId, config);

  const { text: context, hasSubstance } = await gatherContext(tenant, config.supabase, {
    periodic: true,
    timezone: getUserTimezone(config, userId),
  });
  if (!hasSubstance) return;

  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const result = await checkImpulse(client, context);

  if (!result.act || !result.thought) return;

  _cooldowns.set(userId, Date.now());
  sendImpulse(bot, userId, result.thought, result.kind || 'checkin', userId);
}

module.exports = { maybeImpulse, maybePeriodicImpulse };
