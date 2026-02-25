async function routeMessage(client, memory, userMessage, { vlog, onRouteDecision, onRouteUpdate, recentHistory = [] }) {
  let memoryBlock = null;
  let model = null;

  try {
    const lastAssistantMsgs = recentHistory
      .filter(m => m.role === 'assistant')
      .slice(-3)
      .map(m => typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text).join(''))
      .filter(Boolean);

    const contextNote = lastAssistantMsgs.length > 0
      ? `\n\nRecent assistant context (last ${lastAssistantMsgs.length} turns):\n${lastAssistantMsgs.map((t, i) => `[${i + 1}] ${t.substring(0, 300)}`).join('\n')}`
      : '';

    const routerDecision = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: `You are a router. Analyze this user message and decide:

1. Does it need memory context? (past conversations, facts, preferences, people, events)
2. What model complexity does it need?

Reply with ONLY a JSON object:
{"need_memory": true/false, "search_queries": ["query1", "query2"], "model": "haiku|sonnet|opus"}

search_queries: 1-3 optimized search queries covering different topics in the message. One query per distinct topic/entity. Single-topic messages need just one query.

Memory: casual messages (greetings, jokes, simple questions) → false. References to past, people, projects, preferences → true.

Model: Default to "sonnet". Use "haiku" for: greetings, brief acknowledgments (thanks/ok/bye), casual chitchat, quick yes/no questions, and short single-turn exchanges that don't need any tool calling. Use "sonnet" for: code generation, data analysis, content creation, explanations, creative writing, agentic tool use, general questions, opinions, advice, and most conversational exchanges with substance. Use "opus" for: professional software engineering tasks, advanced multi-step agent work, complex reasoning, scientific or mathematical problems, tasks requiring nuanced understanding, advanced coding challenges, in-depth research, and architecture or design decisions.

If recent context shows an ongoing task (sonnet/opus was just used, multi-step work in progress), bias toward that model even for short follow-up messages.${contextNote}`,
      messages: [{ role: 'user', content: userMessage }],
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
      const searchQueries = queries.length > 0 ? queries : [userMessage];

      const recentMemories = await memory.byDate('2d', { limit: Math.ceil(budget / 3) });

      const semanticResults = await Promise.all(
        searchQueries.map(q => memory.search(q, { limit: Math.ceil(budget / searchQueries.length), threshold: 0.4 }))
      );
      const semanticMemories = semanticResults.flat();

      const seen = new Set();
      const combined = [];
      for (const m of [...recentMemories, ...semanticMemories]) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          const recencyBonus = m.created_at ? Math.max(0, 1 - (Date.now() - new Date(m.created_at).getTime()) / (7 * 86400000)) * 0.15 : 0;
          m._score = (m.similarity || 0.5) * 0.6 + (m.importance || 0.5) * 0.25 + recencyBonus;
          combined.push(m);
        }
      }

      combined.sort((a, b) => b._score - a._score);
      const topFacts = combined.slice(0, budget);

      vlog(`[memory] ${topFacts.length} facts (${recentMemories.length} recent, ${semanticMemories.length} semantic, budget=${budget})`);
      onRouteUpdate?.({ memoryCount: topFacts.length });

      if (topFacts.length > 0) {
        const lines = topFacts.map(m => {
          const date = m.created_at ? new Date(m.created_at).toISOString().slice(0, 10) : '';
          return `- [${m.category}] ${m.content}${date ? ` (${date})` : ''}`;
        });
        memoryBlock = `## Relevant memories\n${lines.join('\n')}`;
      }
    }
  } catch (e) {
    console.error('[router] Memory/routing decision failed:', e.message);
    vlog(`[router] ERROR: ${e.message}`);
  }

  return { model, memoryBlock };
}

module.exports = { routeMessage };
