function sanitizeMessages(messages) {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      if (msg.content === '') {
        return { ...msg, content: msg.role === 'assistant' ? null : '(empty)' };
      }
      return msg;
    }
    if (Array.isArray(msg.content)) {
      const filtered = msg.content
        .filter(b => !(b.type === 'text' && b.text === ''))
        .map(b => {
          if (b.citations) {
            const { citations, ...rest } = b;
            return rest;
          }
          return b;
        });
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

function stripToolBlocks(messages) {
  const result = [];
  for (const msg of messages) {
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text)
        .join('\n');
    }
    if (!text.trim()) continue;
    if (result.length > 0 && result[result.length - 1].role === msg.role) {
      result[result.length - 1].content += '\n' + text;
    } else {
      result.push({ role: msg.role, content: text });
    }
  }
  while (result.length > 0 && result[0].role !== 'user') {
    result.shift();
  }
  return result;
}

module.exports = { withCacheBreakpoints, sanitizeMessages, stripToolBlocks };
