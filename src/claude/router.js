const { formatMemoryBlock } = require('./prompt');

function buildRouterMessages(recentHistory, userMessage) {
  const context = recentHistory.slice(-20).map(m => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content.substring(0, 500)
      : m.content.filter(b => b.type === 'text').map(b => b.text).join('').substring(0, 500),
  })).filter(m => m.content);

  const firstUserIdx = context.findIndex(m => m.role === 'user');
  const trimmed = firstUserIdx > 0 ? context.slice(firstUserIdx) : context;

  return [...trimmed, { role: 'user', content: userMessage }];
}

function extractRecentUserMessages(recentHistory, userMessage, count = 5) {
  const userMsgs = recentHistory
    .filter(m => m.role === 'user')
    .map(m => typeof m.content === 'string'
      ? m.content
      : m.content.filter(b => b.type === 'text').map(b => b.text).join(''))
    .filter(Boolean)
    .slice(-count);
  userMsgs.push(userMessage);
  return userMsgs;
}

function tokenize(s) {
  return new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
}

function jaccardFromSets(setA, setB) {
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return inter / (setA.size + setB.size - inter);
}

async function routeMessage(client, memory, userMessage, { vlog, onRouteDecision, onRouteUpdate, recentHistory = [], selfMemory = null }) {
  let memoryBlock = null;
  let model = null;

  try {
    const routerDecision = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: `You are a router. Analyze the conversation and decide:

1. Does it need memory context? (past conversations, facts, preferences, people, events)
2. What model complexity does it need?

Reply with ONLY a JSON object:
{"need_memory": true/false, "model": "sonnet|opus"}

Memory: casual messages (greetings, jokes, simple questions) → false. References to past, people, projects, preferences → true.

Model: Default to "sonnet". Use "sonnet" for: general conversation, code generation, data analysis, content creation, explanations, creative writing, agentic tool use, questions, opinions, advice, memory-dependent questions, and most exchanges. Use "opus" for: professional software engineering tasks, advanced multi-step agent work, complex reasoning, scientific or mathematical problems, tasks requiring nuanced understanding, advanced coding challenges, in-depth research, and architecture or design decisions.

If recent context shows an ongoing task (sonnet/opus was just used, multi-step work in progress), bias toward that model even for short follow-up messages.`,
      messages: buildRouterMessages(recentHistory, userMessage),
    });

    const decisionText = routerDecision.content[0]?.text || '';
    let decision = {};
    try {
      const jsonStr = decisionText.match(/\{[\s\S]*\}/)?.[0];
      if (jsonStr) decision = JSON.parse(jsonStr);
    } catch {}

    if (decision.model !== 'sonnet' && decision.model !== 'opus') {
      decision.model = 'sonnet';
    }

    vlog(`[router] model=${decision.model} memory=${decision.need_memory || false}`);

    onRouteDecision?.({
      model: decision.model,
      needMemory: decision.need_memory || false,
      memoryCount: 0,
    });

    if (decision.model === 'opus') {
      model = 'claude-opus-4-6';
    }

    if (decision.need_memory && memory) {
      const budget = decision.model === 'opus' ? 60 : 40;
      const poolPerQuery = decision.model === 'opus' ? 25 : 20;
      const conversationQueries = extractRecentUserMessages(recentHistory, userMessage);

      const semanticResults = await Promise.all(
        conversationQueries.map(q => memory.search(q, { limit: poolPerQuery, threshold: 0.4 }))
      );
      const semanticMemories = semanticResults.flat();

      const seen = new Set();
      const combined = [];
      for (const m of semanticMemories) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          m._score = (m.similarity || 0.5) * 0.7 + (m.importance || 0.5) * 0.3;
          combined.push(m);
        }
      }

      combined.sort((a, b) => b._score - a._score);

      for (const m of combined) m._tokens = tokenize(m.content);

      const topFacts = [];
      for (const m of combined) {
        if (topFacts.length >= budget) break;
        const isDup = topFacts.some(kept => jaccardFromSets(kept._tokens, m._tokens) > 0.7);
        if (!isDup) topFacts.push(m);
      }

      vlog(`[memory] ${topFacts.length} facts from ${conversationQueries.length} conversation queries (${semanticMemories.length} candidates, budget=${budget})`);
      onRouteUpdate?.({ memoryCount: topFacts.length });

      memoryBlock = formatMemoryBlock(topFacts);
    }
  } catch (e) {
    console.error('[router] Memory/routing decision failed:', e.message);
    vlog(`[router] ERROR: ${e.message}`);
  }

  return { model, memoryBlock };
}

module.exports = { routeMessage };
