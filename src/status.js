const TERM_WIDTH = 25;
const _toolDescriptionCache = new Map();

function buildStatusHtml({ route, elapsed, toolStatus, title = 'OBOL' }) {
  const pad = Math.max(0, TERM_WIDTH - title.length - 3);
  const lines = [`◈ ${title} ${'━'.repeat(pad)}`];
  if (route) {
    lines.push(`⬡ ROUTE  ${(route.model || 'sonnet').toUpperCase()}`);
    if (route.memoryCount > 0 || route.selfMemoryCount > 0) {
      const parts = [];
      if (route.memoryCount > 0) parts.push(`${route.memoryCount} recalled`);
      if (route.selfMemoryCount > 0) parts.push(`${route.selfMemoryCount} self`);
      lines.push(`⬡ MEMORY ${parts.join(' · ')}`);
    } else if (route.needMemory) {
      lines.push(`⬡ MEMORY scanning`);
    }
  }
  if (toolStatus) {
    lines.push(`▸ ${toolStatus}`);
  } else {
    lines.push(`▸ Processing`);
  }
  const es = elapsed > 0 ? ` ${elapsed}s ` : '';
  const padLen = Math.max(0, TERM_WIDTH - es.length);
  const left = Math.floor(padLen / 2);
  const right = padLen - left;
  lines.push(`${'━'.repeat(left)}${es}${'━'.repeat(right)}`);
  return `<pre>${lines.join('\n')}</pre>`;
}

function describeToolCall(client, toolName, inputSummary) {
  const key = `${toolName}:${inputSummary}`;
  const cached = _toolDescriptionCache.get(key);
  if (cached) return Promise.resolve(cached);

  return client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 30,
    system: 'Describe this tool call in 3-8 words from the user\'s perspective. Present participle. No quotes, period, or emoji.',
    messages: [{ role: 'user', content: `${toolName}: ${inputSummary}` }],
  }).then(r => {
    const desc = r.content[0]?.text?.trim() || null;
    if (desc) _toolDescriptionCache.set(key, desc);
    if (_toolDescriptionCache.size > 200) {
      const first = _toolDescriptionCache.keys().next().value;
      _toolDescriptionCache.delete(first);
    }
    return desc;
  }).catch(() => null);
}

module.exports = { buildStatusHtml, describeToolCall, TERM_WIDTH };
