const { TERM_WIDTH } = require('../status');

function termBar(pct, width = 20) {
  const filled = Math.round((pct / 100) * width);
  return '━'.repeat(filled) + '╌'.repeat(width - filled);
}

function markdownToTelegramHtml(text) {
  const codeBlocks = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    codeBlocks.push(`<pre>${escaped}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  const inlineCode = [];
  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCode.length;
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    inlineCode.push(`<code>${escaped}</code>`);
    return `\x00IC${idx}\x00`;
  });

  result = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');
  result = result.replace(/(?<!\w)\*([^\s*](?:.*?[^\s*])?)\*(?!\w)/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_([^\s_](?:.*?[^\s_])?)_(?!\w)/g, '<i>$1</i>');

  result = result.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCode[parseInt(idx)]);

  return result;
}

function sendHtml(ctx, text, extra = {}) {
  const html = markdownToTelegramHtml(text);
  return ctx.reply(html, { parse_mode: 'HTML', ...extra }).catch(() => ctx.reply(text, extra));
}

function editHtml(ctx, chatId, messageId, text, extra = {}) {
  const html = markdownToTelegramHtml(text);
  return ctx.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML', ...extra })
    .catch(() => ctx.api.editMessageText(chatId, messageId, text, extra));
}

function startTyping(ctx) {
  ctx.replyWithChatAction('typing').catch(() => {});
  const interval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 8000);
  return () => clearInterval(interval);
}

function formatTraits(traits) {
  const maxLen = Math.max(...Object.keys(traits).map(k => k.length));
  return Object.entries(traits).map(([name, val]) => {
    const label = (name.charAt(0).toUpperCase() + name.slice(1)).padEnd(maxLen + 1);
    return `  ${label}${termBar(val)} ${val}`;
  }).join('\n');
}

function splitMessage(text, maxLength) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

module.exports = { termBar, markdownToTelegramHtml, sendHtml, editHtml, startTyping, formatTraits, splitMessage };
