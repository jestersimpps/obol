const TERM_WIDTH = 25;

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

function formatToolCall(toolName, inputSummary) {
  if (!inputSummary) return toolName;
  const truncated = inputSummary.length > 40 ? inputSummary.slice(0, 37) + '...' : inputSummary;
  return `${toolName} "${truncated}"`;
}

module.exports = { buildStatusHtml, formatToolCall, TERM_WIDTH };
