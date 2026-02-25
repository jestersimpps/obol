const { getTenant } = require('../../tenant');

function register(bot, config) {
  bot.command('memory', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    if (!tenant.memory) return ctx.reply('Memory not configured.');
    const args = ctx.message.text.split(' ').slice(1);
    const sub = args[0];

    if (sub === 'search' && args[1]) {
      const results = await tenant.memory.search(args.slice(1).join(' '));
      if (results.length === 0) return ctx.reply('No memories found.');
      const text = results.map((m, i) =>
        `${i + 1}. [${m.category}] ${m.content.substring(0, 100)}`
      ).join('\n');
      return ctx.reply(`🔍 Found ${results.length}:\n\n${text}`);
    }

    if (sub === 'stats') {
      const stats = await tenant.memory.stats();
      return ctx.reply(`📊 ${stats.total} memories\n\n${stats.breakdown}`);
    }

    return ctx.reply('Usage: /memory search <query> | /memory stats');
  });

  bot.command('recent', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    if (!tenant.memory) return ctx.reply('Memory not configured.');
    const results = await tenant.memory.recent({ limit: 10 });
    if (results.length === 0) return ctx.reply('No memories yet.');
    const text = results.map((m, i) => {
      const time = new Date(m.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return `${i + 1}. [${time}] [${m.category}] ${m.content.substring(0, 80)}`;
    }).join('\n');
    await ctx.reply(`🕐 Recent memories:\n\n${text}`);
  });

  bot.command('today', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    if (!tenant.memory) return ctx.reply('Memory not configured.');
    const results = await tenant.memory.byDate('today', { limit: 20 });
    if (results.length === 0) return ctx.reply('Nothing stored today yet.');
    const text = results.map((m, i) => {
      const time = new Date(m.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return `${i + 1}. [${time}] [${m.category}] ${m.content.substring(0, 80)}`;
    }).join('\n');
    await ctx.reply(`📅 Today (${results.length} memories):\n\n${text}`);
  });

  bot.command('forget', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    if (!tenant.memory) return ctx.reply('Memory not configured.');
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /forget <memory-id>');
    try {
      await tenant.memory.forget(id);
      await ctx.reply(`🗑️ Forgotten: ${id}`);
    } catch (e) {
      await ctx.reply(`⚠️ ${e.message}`);
    }
  });
}

module.exports = { register };
