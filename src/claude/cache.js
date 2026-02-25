function sanitizeMessages(messages) {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      if (msg.content === '') {
        return { ...msg, content: msg.role === 'assistant' ? null : '(empty)' };
      }
      return msg;
    }
    if (Array.isArray(msg.content)) {
      const filtered = msg.content.filter(b => !(b.type === 'text' && b.text === ''));
      return { ...msg, content: filtered.length ? filtered : null };
    }
    return msg;
  });
}

function withCacheBreakpoints(messages) {
  if (messages.length < 2) return messages;
  const result = messages.slice();
  const idx = result.length - 2;
  const msg = { ...result[idx] };
  if (typeof msg.content === 'string') {
    msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(msg.content)) {
    const last = msg.content.length - 1;
    msg.content = msg.content.map((block, i) =>
      i === last ? { ...block, cache_control: { type: 'ephemeral' } } : block
    );
  }
  result[idx] = msg;
  return result;
}

module.exports = { withCacheBreakpoints, sanitizeMessages };
