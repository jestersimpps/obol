const { Bot, GrammyError, HttpError } = require('grammy');
const {
  isFirstRun, markFirstRunComplete, FIRST_RUN_SYSTEM,
  parseSetupResponse, cleanResponse, writePersonalityFromSetup,
} = require('./first-run');
const { loadConfig } = require('./config');
const { isPostSetupDone, runPostSetup } = require('./post-setup');
const { shouldEvolve, evolve } = require('./evolve');
const { getTenant } = require('./tenant');


function createBot(telegramConfig, config) {
  const bot = new Bot(telegramConfig.token);
  const allowedUsers = new Set(telegramConfig.allowedUsers || []);
  const firstRunHistories = new Map();

  bot.use(async (ctx, next) => {
    if (allowedUsers.size > 0 && !allowedUsers.has(ctx.from?.id)) {
      return;
    }
    await next();
  });

  bot.api.setMyCommands([
    { command: 'new', description: 'Start a fresh conversation' },
    { command: 'tasks', description: 'Show running background tasks' },
    { command: 'status', description: 'Bot status and uptime' },
    { command: 'backup', description: 'Trigger GitHub backup now' },
    { command: 'clean', description: 'Audit and fix workspace' },
  ]).catch(() => {});

  bot.command('start', async (ctx) => {
    await ctx.reply('🪙 OBOL is ready. Just send me a message.');
  });

  bot.command('memory', async (ctx) => {
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

  bot.command('new', async (ctx) => {
    const tenant = await getTenant(ctx.from.id, config);
    tenant.claude.clearHistory(ctx.chat.id);
    await ctx.reply('🪙 Fresh start. What\'s up?');
  });

  bot.command('status', async (ctx) => {
    const tenant = await getTenant(ctx.from.id, config);
    const uptime = process.uptime();
    const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const running = tenant.bg.getStatus();

    let text = `🪙 OBOL Status\n\n`;
    text += `⏱️ Uptime: ${h}h ${m}m\n`;
    text += `💾 Memory: ${mem}MB\n`;
    text += `⚡ Tasks: ${running.length} running\n`;

    if (tenant.memory) {
      const stats = await tenant.memory.stats().catch(() => null);
      if (stats) text += `🧠 Memories: ${stats.total}`;
    }

    await ctx.reply(text);
  });

  bot.command('backup', async (ctx) => {
    try {
      const cfg = loadConfig();
      if (!cfg?.github) return ctx.reply('GitHub backup not configured.');
      const tenant = await getTenant(ctx.from.id, config);
      const { runBackup } = require('./backup');
      await ctx.reply('📦 Running backup...');
      await runBackup(cfg.github, null, tenant.userDir);
      await ctx.reply('✅ Backup complete');
    } catch (e) {
      await ctx.reply(`⚠️ Backup failed: ${e.message}`);
    }
  });

  bot.command('forget', async (ctx) => {
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

  bot.command('recent', async (ctx) => {
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

  bot.command('clean', async (ctx) => {
    const tenant = await getTenant(ctx.from.id, config);
    const { cleanWorkspace } = require('./clean');
    await ctx.replyWithChatAction('typing');
    try {
      const result = await cleanWorkspace(tenant.userDir);
      if (result.issues.length === 0) {
        await ctx.reply('✨ Workspace is clean. Nothing out of place.');
      } else {
        const text = `🧹 Found ${result.issues.length} issue(s):\n\n` +
          result.issues.map(i => `${i.action === 'deleted' ? '🗑️' : '📦'} ${i.path} → ${i.action}`).join('\n') +
          (result.errors.length > 0 ? `\n\n⚠️ ${result.errors.length} error(s):\n${result.errors.join('\n')}` : '');
        await ctx.reply(text);
      }
    } catch (e) {
      await ctx.reply(`⚠️ Clean failed: ${e.message}`);
    }
  });

  bot.command('tasks', async (ctx) => {
    const tenant = await getTenant(ctx.from.id, config);
    const running = tenant.bg.getStatus();
    if (running.length === 0) {
      return ctx.reply('No background tasks running.');
    }
    const text = running.map(t =>
      `⏳ #${t.id}: ${t.task}... (${t.elapsed})`
    ).join('\n');
    return ctx.reply(`Running tasks:\n\n${text}`);
  });

  bot.on('message:text', async (ctx) => {
    const userMessage = ctx.message.text;
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || 'User';

    try {
      await ctx.replyWithChatAction('typing');

      const tenant = await getTenant(userId, config);

      tenant.messageLog?.log(ctx.chat.id, 'user', userMessage);

      let response;

      if (isFirstRun(tenant.userDir)) {
        if (!firstRunHistories.has(userId)) firstRunHistories.set(userId, []);
        const history = firstRunHistories.get(userId);
        history.push({ role: 'user', content: userMessage });

        const msg = await tenant.claude.client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: FIRST_RUN_SYSTEM,
          messages: history,
        });

        const fullText = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        history.push({ role: 'assistant', content: fullText });

        const setup = parseSetupResponse(fullText);
        if (setup?.ready) {
          const cfg = loadConfig();
          writePersonalityFromSetup(setup, cfg?.bot?.name, tenant.userDir);
          markFirstRunComplete(tenant.userDir);
          tenant.claude.reloadPersonality?.();

          if (!isPostSetupDone(tenant.userDir)) {
            const rawCfg = loadConfig({ resolve: false });
            await runPostSetup(rawCfg, async (msg) => {
              await ctx.reply(msg).catch(() => {});
            }, tenant.userDir);
          }

          firstRunHistories.delete(userId);
        }

        response = cleanResponse(fullText);
      } else {
        response = await tenant.claude.chat(userMessage, {
          userId,
          userName,
          chatId: ctx.chat.id,
          bg: tenant.bg,
          ctx,
          _notifyFn: (targetUserId, message) => bot.api.sendMessage(targetUserId, message),
        });
      }

      tenant.messageLog?.log(ctx.chat.id, 'assistant', response);

      if (tenant.messageLog && await shouldEvolve(tenant.userDir).catch(() => false)) {
        setImmediate(async () => {
          try {
            const result = await evolve(tenant.claude.client, tenant.messageLog, tenant.memory, tenant.userDir);
            tenant.claude.reloadPersonality?.();
            let msg = `🪙 Evolution #${result.evolutionNumber} complete.`;

            if (result.scriptsFixed) {
              msg += '\n🔧 Fixed a test regression automatically.';
            } else if (result.scriptsRolledBack) {
              msg += '\n⚠️ Rolled back a script refactor — tests couldn\'t be fixed.';
            }

            if (result.upgrades && result.upgrades.length > 0) {
              msg += '\n\n🆕 **New capabilities:**';
              for (const u of result.upgrades) {
                msg += `\n• **${u.name}** — ${u.description}`;
                if (u.command) msg += ` → \`${u.command}\``;
              }
            }

            if (result.deployedApps && result.deployedApps.length > 0) {
              msg += '\n\n🚀 **Deployed:**';
              for (const app of result.deployedApps) {
                if (app.url) {
                  msg += `\n• ${app.name} → ${app.url}`;
                } else if (app.error) {
                  msg += `\n• ${app.name} — deploy failed: ${app.error.substring(0, 100)}`;
                }
              }
            }

            if (result.changelog) {
              msg += `\n\n_${result.changelog}_`;
            }

            await ctx.reply(msg, { parse_mode: 'Markdown' }).catch(() =>
              ctx.reply(msg).catch(() => {})
            );
          } catch (e) {
            console.error('Evolution failed:', e.message);
          }
        });
      }

      if (response.length > 4096) {
        const chunks = splitMessage(response, 4096);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() =>
            ctx.reply(chunk)
          );
        }
      } else {
        await ctx.reply(response, { parse_mode: 'Markdown' }).catch(() =>
          ctx.reply(response)
        );
      }
    } catch (e) {
      console.error('Message handling error:', e.message);
      await ctx.reply('⚠️ Something went wrong. Check logs with `obol logs`.');
    }
  });

  bot.on('message:photo', async (ctx) => {
    await ctx.reply('📷 Image support coming soon.');
  });

  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    console.error(`[bot.catch] Error while handling update ${ctx?.update?.update_id}:`);

    if (e instanceof GrammyError) {
      console.error(`  Grammy error: ${e.description}`);
    } else if (e instanceof HttpError) {
      console.error(`  HTTP error: ${e.message}`);
    } else {
      console.error(`  Unknown error:`, e?.message || e);
    }

    ctx?.reply?.('⚠️ Something went wrong. I\'m still alive though.').catch(() => {});
  });

  const originalStart = bot.start.bind(bot);
  bot.start = async function startWithResilience(opts = {}) {
    const MAX_RETRIES = 10;
    const BASE_DELAY = 1000;
    let retries = 0;

    const attempt = async () => {
      try {
        retries = 0;
        await originalStart({
          ...opts,
          onStart: (info) => {
            console.log(`  Bot: @${info.username}`);
            opts.onStart?.(info);
          },
        });
      } catch (e) {
        retries++;
        if (retries > MAX_RETRIES) {
          console.error(`💀 Polling failed ${MAX_RETRIES} times. Giving up.`);
          process.exit(1);
        }
        const delay = Math.min(BASE_DELAY * Math.pow(2, retries - 1), 60000);
        console.error(`⚠️ Polling error (attempt ${retries}/${MAX_RETRIES}): ${e.message}`);
        console.error(`  Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        return attempt();
      }
    };

    return attempt();
  };

  return bot;
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

module.exports = { createBot };
