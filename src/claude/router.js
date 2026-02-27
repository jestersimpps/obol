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

function jaccardSim(a, b) {
  const words = s => new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
  const setA = words(a), setB = words(b);
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
{"need_memory": true/false, "search_queries": ["query1", "query2"], "model": "haiku|sonnet|opus"}

search_queries: 1-5 optimized search queries based on the full conversation context. Cover distinct topics, people, entities, time periods, or projects referenced. Single-topic messages need just one query. Use more queries when the message references multiple people, projects, or threads.

Memory: casual messages (greetings, jokes, simple questions) → false. References to past, people, projects, preferences → true.

Model: Default to "sonnet". Use "haiku" for: greetings, brief acknowledgments (thanks/ok/bye), casual chitchat, quick yes/no questions, and short single-turn exchanges that don't need any tool calling. Use "sonnet" for: code generation, data analysis, content creation, explanations, creative writing, agentic tool use, general questions, opinions, advice, and most conversational exchanges with substance. Use "opus" for: professional software engineering tasks, advanced multi-step agent work, complex reasoning, scientific or mathematical problems, tasks requiring nuanced understanding, advanced coding challenges, in-depth research, and architecture or design decisions.

If recent context shows an ongoing task (sonnet/opus was just used, multi-step work in progress), bias toward that model even for short follow-up messages.`,
      messages: buildRouterMessages(recentHistory, userMessage),
    });

    const decisionText = routerDecision.content[0]?.text || '';
    let decision = {};
    try {
      const jsonStr = decisionText.match(/\{[\s\S]*\}/)?.[0];
      if (jsonStr) decision = JSON.parse(jsonStr);
    } catch {}

    const queries = Array.isArray(decision.search_queries) && decision.search_queries.length > 0
      ? decision.search_queries.slice(0, 3)
      : decision.search_query ? [decision.search_query] : [];

    vlog(`[router] model=${decision.model || 'sonnet'} memory=${decision.need_memory || false}${queries.length ? ` queries=${JSON.stringify(queries)}` : ''}`);

    onRouteDecision?.({
      model: decision.model || 'sonnet',
      needMemory: decision.need_memory || false,
      memoryCount: 0,
    });

    if (decision.model === 'opus') {
      model = 'claude-opus-4-6';
    } else if (decision.model === 'haiku') {
      model = 'claude-haiku-4-5';
    }

    if (decision.need_memory && memory) {
      const budget = decision.model === 'opus' ? 40 : decision.model === 'haiku' ? 15 : 25;
      const poolPerQuery = decision.model === 'opus' ? 20 : decision.model === 'haiku' ? 10 : 15;
      const searchQueries = queries.length > 0 ? queries : [userMessage];

      const recentMemories = await memory.byDate('7d', { limit: Math.ceil(budget / 3) });

      const semanticResults = await Promise.all(
        searchQueries.map(q => memory.search(q, { limit: poolPerQuery, threshold: 0.4 }))
      );
      const semanticMemories = semanticResults.flat();

      const seen = new Set();
      const combined = [];
      for (const m of [...recentMemories, ...semanticMemories]) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          const ageDays = m.created_at ? (Date.now() - new Date(m.created_at).getTime()) / 86400000 : 7;
          const recencyBonus = Math.max(0, 1 - ageDays / 7) * 0.3;
          m._score = (m.similarity || 0.5) * 0.5 + (m.importance || 0.5) * 0.2 + recencyBonus;
          combined.push(m);
        }
      }

      combined.sort((a, b) => b._score - a._score);

      const topFacts = [];
      for (const m of combined) {
        if (topFacts.length >= budget) break;
        const isDup = topFacts.some(kept => jaccardSim(kept.content, m.content) > 0.7);
        if (!isDup) topFacts.push(m);
      }

      vlog(`[memory] ${topFacts.length} facts (${recentMemories.length} recent, ${semanticMemories.length} semantic, budget=${budget})`);
      onRouteUpdate?.({ memoryCount: topFacts.length });

      if (topFacts.length > 0) {
        const lines = topFacts.map(m => {
          const date = m.created_at ? new Date(m.created_at).toISOString().slice(0, 10) : '';
          return `- [${m.category}] ${m.content}${date ? ` (${date})` : ''}`;
        });
        memoryBlock = `## Relevant memories\n${lines.join('\n')}`;
      }

      if (selfMemory) {
        const selfResults = await Promise.all(
          searchQueries.map(q => selfMemory.search(q, { limit: 5, threshold: 0.4 }))
        );
        const seen2 = new Set();
        const topSelf = [];
        for (const m of selfResults.flat()) {
          if (!seen2.has(m.id)) { seen2.add(m.id); topSelf.push(m); }
        }
        if (topSelf.length > 0) {
          const selfLines = topSelf.slice(0, 8).map(m => `- [${m.category}] ${m.content}`);
          memoryBlock = (memoryBlock || '') + `\n\n## Self-knowledge\n${selfLines.join('\n')}`;
          vlog(`[memory] +${topSelf.length} self-memory facts`);
          onRouteUpdate?.({ selfMemoryCount: topSelf.length });
        }
      }
    }
  } catch (e) {
    console.error('[router] Memory/routing decision failed:', e.message);
    vlog(`[router] ERROR: ${e.message}`);
  }

  return { model, memoryBlock };
}

module.exports = { routeMessage };
