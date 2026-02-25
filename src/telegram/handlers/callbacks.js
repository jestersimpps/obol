const { markdownToTelegramHtml } = require('../utils');
const { handleToolCallback } = require('../commands/tools');
const { handleVoiceCallback } = require('../voice');

function registerCallbackHandler(bot, { config, pendingAsks, getTenant }) {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const answer = (opts) => ctx.answerCallbackQuery(opts).catch(() => {});

    if (data.startsWith('stop:')) {
      const chatId = parseInt(data.slice(5));
      const userId = ctx.from.id;
      const tenant = await getTenant(userId, config);
      const stopped = tenant?.claude?.stopChat(chatId);
      await answer({ text: stopped ? 'Stopping...' : 'Nothing to stop' });
      return;
    }

    if (data.startsWith('force:')) {
      const chatId = parseInt(data.slice(6));
      const userId = ctx.from.id;
      const tenant = await getTenant(userId, config);
      const stopped = tenant?.claude?.forceStopChat(chatId);
      await answer({ text: stopped ? 'Force stopped' : 'Nothing to stop' });
      return;
    }

    if (data.startsWith('tool:')) {
      const featureKey = data.slice(5);
      await handleToolCallback(ctx, featureKey, answer, { getTenant, config, bot });
      return;
    }

    if (data.startsWith('voice:')) {
      await handleVoiceCallback(ctx, data, answer, { getTenant, config });
      return;
    }

    if (!data.startsWith('ask:')) return answer();
    const parts = data.split(':');
    const askId = parseInt(parts[1]);
    const optIdx = parseInt(parts[2]);
    const pending = pendingAsks.get(askId);
    if (!pending) return answer({ text: 'Expired' });
    const selected = pending.options[optIdx];
    await answer({ text: selected });
    clearTimeout(pending.timer);
    pendingAsks.delete(askId);
    const confirmHtml = markdownToTelegramHtml(`${ctx.callbackQuery.message.text}\n\n✓ _${selected}_`);
    ctx.editMessageText(confirmHtml, { parse_mode: 'HTML' }).catch(() => {});
    pending.resolve(selected);
  });
}

module.exports = { registerCallbackHandler };
