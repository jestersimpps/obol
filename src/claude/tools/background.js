const definitions = [{
  name: 'background_task',
  description: 'Spawn a heavy task in the background. Use when a request will take multiple steps (research, building a site, complex analysis). The main conversation stays responsive. The user gets progress check-ins every 30s and the final result when done. Reply to the user with a brief acknowledgment like "On it 🪙" after spawning.',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Detailed description of the task to complete' },
    },
    required: ['task'],
  },
}];

const handlers = {
  async background_task(input, memory, context) {
    const { bg, ctx: telegramCtx, claude: claudeInstance } = context;
    if (!bg || !telegramCtx) return 'Background tasks not available in this context.';
    if (!claudeInstance) return 'Background tasks not available.';
    const taskId = bg.spawn(claudeInstance, input.task, telegramCtx, memory, context);
    if (taskId === null) return 'Too many background tasks running. Wait for one to finish.';
    return `Background task #${taskId} spawned. It will send progress updates and the final result to the chat.`;
  },
};

module.exports = { definitions, handlers };
