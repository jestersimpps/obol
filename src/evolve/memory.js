async function deepConsolidateMemory(claudeClient, memory, messages, evolutionNumber, model) {
  const transcript = messages.map(m =>
    `${m.role === 'user' ? 'Human' : 'Bot'}: ${m.content.substring(0, 800)}`
  ).join('\n');

  const response = await claudeClient.messages.create({
    model,
    max_tokens: 4096,
    system: `You are doing a deep memory consolidation pass during an AI evolution cycle. Atomic facts are already extracted per-turn by Haiku — your job is to find HIGHER-LEVEL patterns, lessons, and insights that span multiple conversations.

Return JSON:
{
  "memories": [
    {
      "content": "specific insight or pattern",
      "category": "lesson|pattern|decision|context",
      "tags": ["tag1", "tag2"],
      "importance": 0.7
    }
  ]
}

Focus on:
- Recurring behavioral patterns across conversations (communication style shifts, recurring frustrations)
- Lessons learned from multi-step interactions (what worked, what didn't)
- Relationship dynamics and how they evolved over the period
- Cross-topic connections the owner might not see themselves
- Project trajectory and momentum (progressing, stalled, pivoted)
- Consolidated preferences that emerged from multiple signals
- Meta-observations about interaction patterns

Do NOT extract:
- Individual atomic facts (already handled by per-turn extraction)
- Simple preferences or one-off details
- Anything that would be a single-exchange observation

Tags: 2-5 specific lowercase keywords.
Importance: 0.5 useful pattern, 0.7 important insight, 0.9 critical lesson.

Be selective — quality over quantity. 3-8 high-value insights is better than 20 atomic facts.`,
    messages: [{ role: 'user', content: transcript }],
  });

  const text = response.content[0]?.text || '';
  const jsonMatch = text.match(/```json?\s*\n?([\s\S]*?)\n?\s*```/) || text.match(/\{[\s\S]*"memories"\s*:\s*\[[\s\S]*?\]\s*\}/);
  if (!jsonMatch) return 0;

  let extracted;
  try {
    extracted = JSON.parse(jsonMatch[1] || jsonMatch[0]);
  } catch {
    return 0;
  }

  if (!extracted.memories?.length) return 0;

  const validCategories = new Set(['fact','preference','decision','lesson','person','project','event','conversation','resource','pattern','context','email']);
  let stored = 0;
  for (const mem of extracted.memories) {
    if (!mem.content || mem.content.length <= 10) continue;
    try {
      const existing = await memory.search(mem.content, { limit: 1, threshold: 0.92 });
      if (existing.length > 0) continue;
    } catch {}
    const category = validCategories.has(mem.category) ? mem.category : 'fact';
    const tags = Array.isArray(mem.tags) ? mem.tags.slice(0, 5) : [];
    const importance = typeof mem.importance === 'number' ? Math.min(1, Math.max(0, mem.importance)) : 0.5;
    await memory.add(mem.content, {
      category,
      tags,
      importance,
      source: `evolution-${evolutionNumber}`,
    }).catch(() => {});
    stored++;
  }
  return stored;
}

module.exports = { deepConsolidateMemory };
