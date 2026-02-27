const credentials = require('../../auth/credentials');
const { getTenant } = require('../../tenant');

function register(bot, config) {
  bot.command('secret', async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const args = ctx.message.text.split(' ').slice(1);
    const sub = args[0];

    if (sub === 'list') {
      const keys = credentials.listSecrets(userId);
      if (keys.length === 0) return ctx.reply('No secrets stored.');
      return ctx.reply(`🔑 Stored secrets:\n\n${keys.map(k => `• ${k}`).join('\n')}`);
    }

    if (sub === 'set' && args[1] && args[2]) {
      const key = args[1];
      const value = args.slice(2).join(' ');
      try {
        ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
        credentials.storeSecret(userId, key, value);
        await ctx.reply(`🔑 Secret "${key}" stored securely.`);
        const tenant = await getTenant(userId, config);
        if (tenant.claude?.injectHistory) {
          tenant.claude.injectHistory(ctx.chat.id, 'user', `[System: user stored secret "${key}" via /secret set]`);
          tenant.claude.injectHistory(ctx.chat.id, 'assistant', `Noted — secret "${key}" is now stored.`);
        }
      } catch (e) {
        await ctx.reply(`⚠️ ${e.message}`);
      }
      return;
    }

    if (sub === 'remove' && args[1]) {
      try {
        credentials.removeSecret(userId, args[1]);
        await ctx.reply(`🗑️ Secret "${args[1]}" removed.`);
        const tenant = await getTenant(userId, config);
        if (tenant.claude?.injectHistory) {
          tenant.claude.injectHistory(ctx.chat.id, 'user', `[System: user removed secret "${args[1]}" via /secret remove]`);
          tenant.claude.injectHistory(ctx.chat.id, 'assistant', `Noted — secret "${args[1]}" has been removed.`);
        }
      } catch (e) {
        await ctx.reply(`⚠️ ${e.message}`);
      }
      return;
    }

    await ctx.reply(`🔑 Secret Management

/secret list — List stored secret keys
/secret set <key> <value> — Store a secret (message auto-deleted)
/secret remove <key> — Remove a secret

Your message is deleted immediately when using /secret set to keep credentials out of chat history.`);
  });
}

module.exports = { register };
