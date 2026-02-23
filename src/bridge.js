const { createAnthropicClient } = require('./claude');

const BRIDGE_MAX_PER_HOUR = 20;
const bridgeUsage = new Map();

function checkBridgeRateLimit(userId) {
  const now = Date.now();
  const hourAgo = now - 3600000;
  const usage = bridgeUsage.get(userId) || [];
  const recent = usage.filter(ts => ts > hourAgo);
  if (recent.length >= BRIDGE_MAX_PER_HOUR) {
    return `Bridge rate limit reached (${BRIDGE_MAX_PER_HOUR}/hour). Try again later.`;
  }
  recent.push(now);
  bridgeUsage.set(userId, recent);
  return null;
}

function isBridgeEnabled(config) {
  return config.bridge?.enabled === true;
}

function getPartnerUserId(userId, config, targetId) {
  const users = config.telegram?.allowedUsers || [];
  if (targetId) {
    if (!users.includes(targetId)) return { error: `User ${targetId} is not in the allowed users list.` };
    if (targetId === userId) return { error: 'Cannot bridge to yourself.' };
    return { partnerId: targetId };
  }
  const others = users.filter(id => id !== userId);
  if (others.length === 0) return { error: 'No other users configured. Add more users with `obol config`.' };
  if (others.length === 1) return { partnerId: others[0] };
  return { error: `Multiple users available (${others.map(id => id).join(', ')}). Specify partner_id to choose which one.` };
}

function buildBridgeTool() {
  return {
    name: 'bridge_ask',
    description: 'Ask your partner\'s AI agent a question. Use this when the user asks about the other person — their preferences, schedule, opinions, or anything their agent would know. The partner agent will answer from its own memory and personality context. The partner gets notified that you asked. If there are 3+ users, you must specify partner_id.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the partner\'s agent' },
        partner_id: { type: 'number', description: 'Target partner user ID (required if 3+ users)' },
      },
      required: ['question'],
    },
  };
}

async function bridgeAsk(question, fromUserId, config, notifyFn, targetId) {
  if (!isBridgeEnabled(config)) return 'Bridge is not enabled.';

  const rateLimitErr = checkBridgeRateLimit(fromUserId);
  if (rateLimitErr) return rateLimitErr;

  const result = getPartnerUserId(fromUserId, config, targetId);
  if (result.error) return result.error;
  const partnerUserId = result.partnerId;

  const { getTenant } = require('./tenant');
  const partner = await getTenant(partnerUserId, config);
  if (!partner) return 'Could not load partner tenant.';

  let memoryContext = '';
  if (partner.memory) {
    try {
      const memories = await partner.memory.search(question, { limit: 5, threshold: 0.5 });
      if (memories.length > 0) {
        memoryContext = '\n\n[Relevant memories]\n' +
          memories.map(m => `- [${m.category}] ${m.content}`).join('\n');
      }
    } catch (e) {
      console.error(`[bridge] Memory search failed for ${partnerUserId}:`, e.message);
    }
  }

  const systemParts = [
    'You are answering a question on behalf of your owner, asked by their partner\'s AI agent.',
    'Answer helpfully but protect privacy — give summaries, not raw data. Never share secrets, passwords, or private messages verbatim.',
  ];

  if (partner.personality?.soul) systemParts.push(`\n## Your Owner's Personality\n${partner.personality.soul}`);
  if (partner.personality?.user) systemParts.push(`\n## About Your Owner\n${partner.personality.user}`);
  if (memoryContext) systemParts.push(memoryContext);

  const client = createAnthropicClient(config.anthropic);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemParts.join('\n'),
    messages: [{ role: 'user', content: question }],
  });

  const answer = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  if (notifyFn) {
    try {
      await notifyFn(partnerUserId, `🪙 Your partner's agent asked about you:\n"${question}"`);
    } catch (e) {
      console.error(`[bridge] Notify failed for ${partnerUserId}:`, e.message);
    }
  }

  if (partner.memory) {
    try {
      await partner.memory.add(`Partner's agent asked: "${question}"`, {
        category: 'event',
        importance: 0.4,
        source: `bridge:${fromUserId}`,
      });
    } catch (e) {
      console.error(`[bridge] Memory store failed for ${partnerUserId}:`, e.message);
    }
  }

  return answer;
}

function buildBridgeTellTool() {
  return {
    name: 'bridge_tell',
    description: 'Send a message to your partner\'s AI agent. Use this when the user wants to tell, remind, or send something to the other person. The message gets stored in the partner\'s memory and delivered as a Telegram notification. The partner\'s agent will see it as context in future conversations. If there are 3+ users, you must specify partner_id.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send to the partner\'s agent' },
        partner_id: { type: 'number', description: 'Target partner user ID (required if 3+ users)' },
      },
      required: ['message'],
    },
  };
}

async function bridgeTell(message, fromUserId, config, notifyFn, targetId) {
  if (!isBridgeEnabled(config)) return 'Bridge is not enabled.';

  const rateLimitErr = checkBridgeRateLimit(fromUserId);
  if (rateLimitErr) return rateLimitErr;

  const result = getPartnerUserId(fromUserId, config, targetId);
  if (result.error) return result.error;
  const partnerUserId = result.partnerId;

  const { getTenant } = require('./tenant');
  const partner = await getTenant(partnerUserId, config);
  if (!partner) return 'Could not load partner tenant.';

  if (partner.memory) {
    try {
      await partner.memory.add(`Message from partner: "${message}"`, {
        category: 'event',
        importance: 0.6,
        source: `bridge:${fromUserId}`,
      });
    } catch (e) {
      console.error(`[bridge] Memory store failed for ${partnerUserId}:`, e.message);
    }
  }

  if (notifyFn) {
    try {
      await notifyFn(partnerUserId, `🪙 Message from your partner's agent:\n"${message}"`);
    } catch (e) {
      console.error(`[bridge] Notify failed for ${partnerUserId}:`, e.message);
    }
  }

  return 'Message delivered and stored in partner\'s memory.';
}

module.exports = { isBridgeEnabled, getPartnerUserId, checkBridgeRateLimit, buildBridgeTool, buildBridgeTellTool, bridgeAsk, bridgeTell };
