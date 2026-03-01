const { getTenant } = require('../../tenant');
const { TERM_SEP } = require('../constants');
const pkg = require('../../../package.json');

function register(bot, config) {
  const botName = config.bot?.name || 'OBOL';
  bot.command('start', async (ctx) => {
    await ctx.reply(`<pre>◈ ${botName} v${pkg.version}\n${TERM_SEP}\nSYSTEM ONLINE\n${TERM_SEP}</pre>`, { parse_mode: 'HTML' });
  });

  bot.command('new', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    tenant.claude.clearHistory(ctx.chat.id);
    await ctx.reply(`<pre>◈ CONTEXT CLEARED\n${TERM_SEP}</pre>`, { parse_mode: 'HTML' });
  });

  bot.command('stop', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    const stopped = tenant.claude.stopChat(ctx.chat.id);
    if (stopped) {
      await ctx.reply(`<pre>◈ PROCESS TERMINATED\n${TERM_SEP}</pre>`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('Nothing running to stop.');
    }
  });

  bot.command('verbose', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    tenant.verbose = !tenant.verbose;
    const state = tenant.verbose ? '◉ ACTIVE' : '○ INACTIVE';
    await ctx.reply(`<pre>◈ VERBOSE ${state}\n${TERM_SEP}</pre>`, { parse_mode: 'HTML' });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(`Commands:

/new — Start fresh conversation
/memory search <query> — Search memories
/memory stats — Memory statistics
/recent — Last 10 memories
/today — Today's memories
/forget <id> — Delete a memory
/events — Upcoming scheduled events
/tasks — Running background tasks
/options — Toggle optional features on/off
/secret — Manage per-user secrets
/evolution — Evolution progress
/status — Bot status and uptime
/backup — Trigger GitHub backup
/clean — Audit workspace
/verbose — Toggle verbose mode on/off
/toolimit — View or set max tool iterations
/stop — Stop the current request
/restart — Restart the bot
/upgrade — Check for updates and upgrade
/help — This message`);
  });
}

module.exports = { register };
