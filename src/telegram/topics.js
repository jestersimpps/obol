const { InlineKeyboard } = require('grammy');
const { sendHtml } = require('./utils');

const MAX_TOPICS = 20;
const PENDING_TTL_MS = 60_000;

/** @type {Map<number, { chatId: number, messageId: number }[]>} */
const topicFlowMessages = new Map();

/** @type {Map<number, { timer: ReturnType<typeof setTimeout> }>} */
const pendingTopicInput = new Map();

function trackMsg(userId, chatId, messageId) {
  if (!topicFlowMessages.has(userId)) topicFlowMessages.set(userId, []);
  topicFlowMessages.get(userId).push({ chatId, messageId });
}

async function clearTopicFlow(userId, bot) {
  const msgs = topicFlowMessages.get(userId);
  if (!msgs) return;
  topicFlowMessages.delete(userId);
  cancelPending(userId);
  for (const { chatId, messageId } of msgs) {
    bot.api.deleteMessage(chatId, messageId).catch(() => {});
  }
}

function cancelPending(userId) {
  const pending = pendingTopicInput.get(userId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingTopicInput.delete(userId);
  }
}

function isPendingTopicInput(userId) {
  return pendingTopicInput.has(userId);
}

function normalizeTopics(raw) {
  return [...new Set(
    raw
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length > 0)
  )].slice(0, MAX_TOPICS);
}

function buildEditorKeyboard(topics) {
  const kb = new InlineKeyboard();
  for (let i = 0; i < topics.length; i++) {
    kb.text(`✕ ${topics[i]}`, `topics:remove:${i}`);
    if ((i + 1) % 2 === 0) kb.row();
  }
  if (topics.length % 2 !== 0) kb.row();
  kb.text('＋ Add topics', 'topics:add').row();
  kb.text('✓ Done', 'topics:done');
  return kb;
}

function buildEditorText(topics) {
  if (topics.length === 0) return 'No topics yet. Add some to get started.';
  return `Your news topics (${topics.length}/${MAX_TOPICS}):`;
}

async function sendTopicEditor(ctx, config) {
  if (!ctx.from) return;
  const userId = ctx.from.id;
  const { getTenant } = require('../tenant');
  const tenant = await getTenant(userId, config);
  const pref = tenant.toolPrefs.get('proactive_news');
  const topics = pref?.config?.topics || [];

  const text = buildEditorText(topics);
  const kb = buildEditorKeyboard(topics);
  const msg = await ctx.reply(text, { reply_markup: kb });
  trackMsg(userId, msg.chat.id, msg.message_id);
}

async function handleTopicCallback(ctx, data, answer, { getTenant, config, bot }) {
  if (!ctx.from) return answer();
  const userId = ctx.from.id;
  const parts = data.split(':');
  const action = parts[1];

  if (action === 'remove') {
    const idx = parseInt(parts[2]);
    const tenant = await getTenant(userId, config);
    const pref = tenant.toolPrefs.get('proactive_news');
    const topics = [...(pref?.config?.topics || [])];
    const removed = topics.splice(idx, 1)[0];
    await answer({ text: removed ? `Removed "${removed}"` : 'Already removed' });

    if (tenant.toolPrefsApi) {
      const newConfig = { ...(pref?.config || {}), topics };
      await tenant.toolPrefsApi.set('proactive_news', true, newConfig);
      await tenant.reloadToolPrefs();
    }

    const text = buildEditorText(topics);
    const kb = buildEditorKeyboard(topics);
    ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
    return;
  }

  if (action === 'add') {
    await answer();
    const pref = (await getTenant(userId, config)).toolPrefs.get('proactive_news');
    const current = pref?.config?.topics || [];
    if (current.length >= MAX_TOPICS) {
      const msg = await ctx.reply(`Max ${MAX_TOPICS} topics. Remove some first.`);
      trackMsg(userId, msg.chat.id, msg.message_id);
      return;
    }

    cancelPending(userId);
    const timer = setTimeout(() => pendingTopicInput.delete(userId), PENDING_TTL_MS);
    pendingTopicInput.set(userId, { timer });

    const msg = await ctx.reply('Type your topics, separated by commas:');
    trackMsg(userId, msg.chat.id, msg.message_id);
    return;
  }

  if (action === 'done') {
    await answer({ text: 'Topics saved' });
    await clearTopicFlow(userId, bot);
    return;
  }

  return answer();
}

async function handleTopicText(ctx, text, { getTenant, config, bot }) {
  const userId = ctx.from.id;
  cancelPending(userId);

  const tenant = await getTenant(userId, config);
  const pref = tenant.toolPrefs.get('proactive_news');
  const existing = pref?.config?.topics || [];
  const incoming = normalizeTopics(text);

  if (incoming.length === 0) {
    const msg = await ctx.reply('No valid topics found. Try again with comma-separated topics.');
    trackMsg(userId, msg.chat.id, msg.message_id);
    return;
  }

  const merged = [...new Set([...existing, ...incoming])].slice(0, MAX_TOPICS);

  if (tenant.toolPrefsApi) {
    const newConfig = { ...(pref?.config || {}), topics: merged };
    await tenant.toolPrefsApi.set('proactive_news', true, newConfig);
    await tenant.reloadToolPrefs();
  }

  const added = merged.length - existing.length;
  const editorText = buildEditorText(merged);
  const kb = buildEditorKeyboard(merged);
  const msg = await ctx.reply(`Added ${added} topic${added !== 1 ? 's' : ''}.\n\n${editorText}`, { reply_markup: kb });
  trackMsg(userId, msg.chat.id, msg.message_id);
}

module.exports = {
  clearTopicFlow,
  sendTopicEditor,
  handleTopicCallback,
  isPendingTopicInput,
  handleTopicText,
};
