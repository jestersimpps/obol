const { handleToolCallback } = require('../commands/tools');
const { handleVoiceCallback } = require('../voice');
const { handleTopicCallback } = require('../topics');
const { handleSchedCallback } = require('../schedule-wizard');

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
      ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
      return;
    }

    if (data.startsWith('force:')) {
      const chatId = parseInt(data.slice(6));
      const userId = ctx.from.id;
      const tenant = await getTenant(userId, config);
      const stopped = tenant?.claude?.forceStopChat(chatId);
      await answer({ text: stopped ? 'Force stopped' : 'Nothing to stop' });
      ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
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

    if (data.startsWith('topics:')) {
      await handleTopicCallback(ctx, data, answer, { getTenant, config, bot });
      return;
    }

    if (data.startsWith('sched:')) {
      await handleSchedCallback(ctx, data, answer, { getTenant, config, bot });
      return;
    }

    if (data.startsWith('bridge:reply:')) {
      const targetUserId = parseInt(data.split(':')[2]);
      const reactingUserId = ctx.from.id;

      const tenant = await getTenant(reactingUserId, config);
      if (!tenant) return answer({ text: 'Could not load your agent' });

      const { checkBridgeRateLimit, bridgeTell } = require('../../bridge');
      const rateErr = checkBridgeRateLimit(reactingUserId);
      if (rateErr) return answer({ text: rateErr });

      let memoryContext = '';
      if (tenant.memory) {
        try {
          const memories = await tenant.memory.search('message from partner bridge', { limit: 5, threshold: 0.3 });
          if (memories.length > 0) {
            memoryContext = '\n\n[Recent bridge messages]\n' + memories.map(m => `- ${m.content}`).join('\n');
          }
        } catch {}
      }

      const systemParts = [
        'Compose a brief, natural reply to send back to your partner\'s agent via bridge. 1-3 sentences. Be genuine and respond to the most recent message from them.',
      ];
      if (tenant.personality?.soul) systemParts.push(`\n## Your Personality\n${tenant.personality.soul}`);
      if (tenant.personality?.user) systemParts.push(`\n## About You\n${tenant.personality.user}`);
      if (memoryContext) systemParts.push(memoryContext);

      let replyText;
      try {
        const response = await tenant.claude.client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          system: systemParts.join('\n'),
          messages: [{ role: 'user', content: 'Compose your reply to send via bridge.' }],
        });
        replyText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      } catch (e) {
        console.error('[bridge:reply] Generation failed:', e.message);
        return answer({ text: 'Failed to generate reply' });
      }

      if (!replyText) return answer({ text: 'Could not generate a reply' });

      const notifyFn = (uid, msg, opts = {}) => ctx.api.sendMessage(uid, msg, opts);
      try {
        await bridgeTell(replyText, reactingUserId, config, notifyFn, targetUserId);
      } catch (e) {
        console.error('[bridge:reply] bridgeTell failed:', e.message);
        return answer({ text: 'Failed to send reply' });
      }

      ctx.editMessageText(
        ctx.callbackQuery.message.text + '\n\n✓ Reply sent',
        { reply_markup: { inline_keyboard: [] } }
      ).catch(() => {});

      return answer({ text: 'Reply sent!' });
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
    ctx.deleteMessage().catch(() => {});
    pending.resolve(selected);
  });
}

module.exports = { registerCallbackHandler };
