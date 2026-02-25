const definitions = [{
  name: 'agent',
  description: 'Spawn a focused sub-agent to handle a specific task and return the result. Use for research, file analysis, or any multi-step work that would clutter the main conversation. Defaults to haiku — use sonnet for tasks requiring deeper reasoning.',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Detailed description of what the sub-agent should do' },
      model: { type: 'string', enum: ['haiku', 'sonnet'], description: 'Model to use (default: haiku)' },
    },
    required: ['task'],
  },
}];

const handlers = {
  async agent(input, memory, context) {
    const { claude } = context;
    if (!claude) return 'Agent tool not available in this context.';

    const depth = context._agentDepth || 0;
    if (depth >= 2) return 'Error: max agent nesting depth reached.';

    const model = input.model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
    const subChatId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const { text } = await claude.chat(input.task, {
      chatId: subChatId,
      _agentDepth: depth + 1,
      _model: model,
      userDir: context.userDir,
      toolPrefs: context.toolPrefs,
      verbose: context.verbose,
      _verboseNotify: context._verboseNotify,
    });

    claude.clearHistory(subChatId);
    return text || '(agent completed with no output)';
  },
};

module.exports = { definitions, handlers };
