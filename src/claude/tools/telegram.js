const definitions = [{
  name: 'telegram_ask',
  description: 'Send a message to the user with inline keyboard buttons and wait for their tap. Use for human-in-the-loop decisions: confirmations, approvals, action selection. Returns the label of the button the user pressed, or "timeout" if they don\'t respond within the timeout.',
  input_schema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Question or prompt to show the user' },
      options: { type: 'array', items: { type: 'string' }, description: 'Button labels (2-6 options, keep each label short)' },
      timeout: { type: 'number', description: 'Seconds to wait for response (default 60)' },
    },
    required: ['message', 'options'],
  },
}];

const handlers = {
  async telegram_ask(input, memory, context) {
    if (!context.telegramAsk) return 'telegram_ask not available in this context.';
    return await context.telegramAsk(input.message, input.options || [], input.timeout);
  },
};

module.exports = { definitions, handlers };
