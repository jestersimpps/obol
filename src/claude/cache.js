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

module.exports = { withCacheBreakpoints };
