const definitions = [
  {
    name: 'chat_history',
    description: 'Retrieve past conversation messages by date. Use to look up what was discussed on a specific day or time range.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date filter: "today", "yesterday", "2026-02-22", "7d" (last 7 days)' },
        role: { type: 'string', enum: ['user', 'assistant'], description: 'Filter by speaker (omit for both)' },
        limit: { type: 'number', description: 'Max messages to return (default 50)' },
      },
      required: ['date'],
    },
  },
];

/**
 * @param {{ role: string, content: string, created_at: string }} m
 * @returns {string}
 */
function formatMessage(m) {
  const ts = new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ');
  const preview = m.content.length > 800 ? m.content.substring(0, 800) + '…' : m.content;
  return `[${ts}] ${m.role.toUpperCase()}: ${preview}`;
}

const handlers = {
  /**
   * @param {{ date: string, role?: string, limit?: number }} input
   * @param {*} memory
   * @param {{ messageLog: import('../../messages').MessageLog, chatId: string|number }} context
   */
  async chat_history(input, memory, context) {
    if (!context.messageLog) return 'Message history not available (Supabase not configured).';
    try {
      const messages = await context.messageLog.getByDate(context.chatId, input.date, {
        role: input.role,
        limit: input.limit,
      });
      if (messages.length === 0) return `No messages found for "${input.date}".`;
      return messages.map(formatMessage).join('\n\n');
    } catch (e) {
      return `Error retrieving history: ${e.message}`;
    }
  },
};

module.exports = { definitions, handlers };
