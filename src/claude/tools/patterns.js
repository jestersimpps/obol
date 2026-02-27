const definitions = [
  {
    name: 'patterns_view',
    description: 'View behavioral patterns learned about the user. Shows timing, mood, humor, engagement, communication, and topic patterns.',
    input_schema: {
      type: 'object',
      properties: {
        dimension: { type: 'string', enum: ['timing', 'mood', 'humor', 'engagement', 'communication', 'topics'], description: 'Filter by dimension (omit for all)' },
      },
    },
  },
  {
    name: 'patterns_delete',
    description: 'Delete a behavioral pattern by its key. Use patterns_view first to see available keys.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Pattern key to delete (e.g. "timing.active_hours", "mood.stress_signals")' },
      },
      required: ['key'],
    },
  },
];

function formatPattern(p) {
  const obs = p.observation_count ? ` (${p.observation_count} observations)` : '';
  const conf = p.confidence != null ? ` [confidence: ${p.confidence}]` : '';
  return `[${p.dimension}] ${p.key}: ${p.summary}${conf}${obs}`;
}

const handlers = {
  async patterns_view(_input, _memory, context) {
    if (!context.patterns) return 'Patterns not available (Supabase not configured).';
    const patterns = _input.dimension
      ? await context.patterns.getByDimension(_input.dimension)
      : await context.patterns.getAll();
    if (!patterns.length) return _input.dimension ? `No ${_input.dimension} patterns found.` : 'No patterns learned yet.';
    return patterns.map(formatPattern).join('\n');
  },

  async patterns_delete(input, _memory, context) {
    if (!context.patterns) return 'Patterns not available (Supabase not configured).';
    const existing = await context.patterns.get(input.key);
    if (!existing) return `Pattern not found: ${input.key}`;
    await context.patterns.remove(input.key);
    return `Deleted pattern: ${input.key}`;
  },
};

const requiresPatterns = true;

module.exports = { definitions, handlers, requiresPatterns };
