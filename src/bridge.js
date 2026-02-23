const Anthropic = require('@anthropic-ai/sdk');

function isBridgeEnabled(config) {
  return config.bridge?.enabled === true;
}

function getPartnerUserId(userId, config) {
  const users = config.telegram?.allowedUsers || [];
  const partner = users.find(id => id !== userId);
  return partner || null;
}

function buildBridgeTool() {
  return {
    name: 'bridge_ask',
    description: 'Ask your partner\'s AI agent a question. Use this when the user asks about the other person — their preferences, schedule, opinions, or anything their agent would know. The partner agent will answer from its own memory and personality context. The partner gets notified that you asked.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the partner\'s agent' },
      },
      required: ['question'],
    },
  };
}

async function bridgeAsk(question, fromUserId, config, notifyFn) {
  if (!isBridgeEnabled(config)) return 'Bridge is not enabled.';

  const partnerUserId = getPartnerUserId(fromUserId, config);
  if (!partnerUserId) return 'No partner user found.';

  const { getTenant } = require('./tenant');
  const partner = await getTenant(partnerUserId, config);
  if (!partner) return 'Could not load partner tenant.';

  let memoryContext = '';
  if (partner.memory) {
    try {
      const memories = await partner.memory.search(question, { limit: 5, threshold: 0.4 });
      if (memories.length > 0) {
        memoryContext = '\n\n[Relevant memories]\n' +
          memories.map(m => `- [${m.category}] ${m.content}`).join('\n');
      }
    } catch {}
  }

  const systemParts = [
    'You are answering a question on behalf of your owner, asked by their partner\'s AI agent.',
    'Answer helpfully but protect privacy — give summaries, not raw data. Never share secrets, passwords, or private messages verbatim.',
  ];

  if (partner.personality?.soul) systemParts.push(`\n## Your Owner's Personality\n${partner.personality.soul}`);
  if (partner.personality?.user) systemParts.push(`\n## About Your Owner\n${partner.personality.user}`);
  if (memoryContext) systemParts.push(memoryContext);

  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

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
    } catch {}
  }

  if (partner.memory) {
    try {
      await partner.memory.add(`Partner's agent asked: "${question}"`, {
        category: 'event',
        importance: 0.4,
        source: `bridge:${fromUserId}`,
      });
    } catch {}
  }

  return answer;
}

function buildBridgeTellTool() {
  return {
    name: 'bridge_tell',
    description: 'Send a message to your partner\'s AI agent. Use this when the user wants to tell, remind, or send something to the other person. The message gets stored in the partner\'s memory and delivered as a Telegram notification. The partner\'s agent will see it as context in future conversations.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send to the partner\'s agent' },
      },
      required: ['message'],
    },
  };
}

async function bridgeTell(message, fromUserId, config, notifyFn) {
  if (!isBridgeEnabled(config)) return 'Bridge is not enabled.';

  const partnerUserId = getPartnerUserId(fromUserId, config);
  if (!partnerUserId) return 'No partner user found.';

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
    } catch {}
  }

  if (notifyFn) {
    try {
      await notifyFn(partnerUserId, `🪙 Message from your partner's agent:\n"${message}"`);
    } catch {}
  }

  return 'Message delivered and stored in partner\'s memory.';
}

module.exports = { isBridgeEnabled, getPartnerUserId, buildBridgeTool, buildBridgeTellTool, bridgeAsk, bridgeTell };
