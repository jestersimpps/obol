const path = require('path');
const { getTenant } = require('../../tenant');
const { loadConfig } = require('../../config');
const { loadTraits } = require('../../personality');
const { evolve, loadEvolutionState } = require('../../evolve');
const { getMaxToolIterations } = require('../../claude');
const { termBar, formatTraits } = require('../utils');
const { TERM_SEP } = require('../constants');

function register(bot, config) {
  bot.command('status', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    const uptime = process.uptime();
    const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const running = tenant.bg.getStatus();
    const pkg = require('../../../package.json');

    const lines = [
      `◈ OBOL SYSTEM STATUS`,
      TERM_SEP,
      ``,
      `RUNTIME`,
      `  uptime   ${h}h ${m}m`,
      `  memory   ${mem}MB`,
      `  tasks    ${running.length} active`,
      `  tools    ${getMaxToolIterations()} max iter`,
    ];

    if (tenant.memory) {
      const stats = await tenant.memory.stats().catch(() => null);
      lines.push(``, `MEMORY BANK`);
      lines.push(`  stored   ${stats ? stats.total : '?'} memories`);
    }

    const ctxStats = tenant.claude.getContextStats(ctx.chat.id);
    lines.push(
      ``, `CONTEXT`,
      `  ${termBar(ctxStats.pct)} ${ctxStats.pct}%`,
      `  ${(ctxStats.estimatedTokens / 1000).toFixed(1)}k / ${(ctxStats.maxTokens / 1000).toFixed(0)}k tokens`,
      `  ${ctxStats.messages} messages`,
    );

    const evoState = loadEvolutionState(tenant.userDir);
    const cfg = loadConfig();
    const intervalHours = cfg?.evolution?.intervalHours ?? 24;
    const elapsed = evoState.lastEvolution ? (Date.now() - new Date(evoState.lastEvolution).getTime()) / 3600000 : Infinity;
    const evoPct = Math.min(100, Math.round((elapsed / intervalHours) * 100));
    const timeLeft = Math.max(0, intervalHours - elapsed);
    lines.push(
      ``, `EVOLUTION`,
      `  ${termBar(evoPct)} ${evoPct}%`,
      `  ${timeLeft < 1 ? 'ready' : `${timeLeft.toFixed(1)}h remaining`} ▪ ${evoState.evolutionCount || 0} completed`,
    );

    const personalityDir = path.join(tenant.userDir, 'personality');
    const traits = loadTraits(personalityDir);
    lines.push(``, `TRAITS`);
    lines.push(formatTraits(traits));
    lines.push(TERM_SEP);

    await ctx.reply(`<pre>${lines.join('\n')}</pre>`, { parse_mode: 'HTML' });
  });

  bot.command('evolution', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    const state = loadEvolutionState(tenant.userDir);
    const cfg = loadConfig();
    const intervalHours = cfg?.evolution?.intervalHours ?? 24;
    const elapsed = state.lastEvolution ? (Date.now() - new Date(state.lastEvolution).getTime()) / 3600000 : Infinity;
    const pct = Math.min(100, Math.round((elapsed / intervalHours) * 100));
    const timeLeft = Math.max(0, intervalHours - elapsed);

    const lines = [
      `◈ OBOL EVOLUTION CYCLE`,
      TERM_SEP,
      ``,
      `  ${termBar(pct)} ${pct}%`,
      `  ${timeLeft < 1 ? 'ready' : `${timeLeft.toFixed(1)}h remaining`}`,
      `  ${state.evolutionCount || 0} completed`,
    ];
    if (state.lastEvolution) {
      lines.push(`  last ${new Date(state.lastEvolution).toLocaleDateString()}`);
    }
    lines.push(TERM_SEP);
    await ctx.reply(`<pre>${lines.join('\n')}</pre>`, { parse_mode: 'HTML' });
  });

  bot.command('events', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    if (!tenant.scheduler) return ctx.reply('Scheduler not configured.');
    const { sendHtml } = require('../utils');
    try {
      const events = await tenant.scheduler.list({ status: 'pending' });
      if (events.length === 0) return ctx.reply('No upcoming events.');
      const text = events.map((e, i) => {
        const tz = e.timezone || 'UTC';
        const dueLocal = new Date(e.due_at).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
        const icon = e.cron_expr ? '🔄' : '📌';
        let line = `${i + 1}. ${icon} *${e.title}*\n   ${dueLocal} (${tz})`;
        if (e.cron_expr) {
          line += `\n   \`${e.cron_expr}\` · ${e.run_count || 0} runs`;
          if (e.max_runs) line += `/${e.max_runs}`;
        }
        line += `\n   \`${e.id}\``;
        return line;
      }).join('\n\n');
      await sendHtml(ctx, `📅 **Upcoming Events**\n\n${text}`);
    } catch (e) {
      await ctx.reply(`⚠️ ${e.message}`);
    }
  });

  bot.command('tasks', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    const running = tenant.bg.getStatus();
    const lines = [`◈ OBOL ACTIVE TASKS`, TERM_SEP];
    if (running.length === 0) {
      lines.push(``, `  (none)`);
    } else {
      lines.push(``);
      for (const t of running) {
        lines.push(`  ▸ #${t.id} ${t.task}`);
        lines.push(`    ${t.elapsed}`);
      }
    }
    lines.push(TERM_SEP);
    return ctx.reply(`<pre>${lines.join('\n')}</pre>`, { parse_mode: 'HTML' });
  });
}

module.exports = { register };
