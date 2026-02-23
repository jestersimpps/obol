const { Bot } = require('grammy');
const {
  isFirstRun, markFirstRunComplete, FIRST_RUN_SYSTEM,
  parseSetupResponse, cleanResponse, writePersonalityFromSetup,
} = require('./first-run');
const { loadConfig } = require('./config');
const { isPostSetupDone, runPostSetup } = require('./post-setup');
const { BackgroundRunner } = require('./background');


function createBot(telegramConfig, claude, memory) {
  const bot = new Bot(telegramConfig.token);
  const allowedUsers = new Set(telegramConfig.allowedUsers || []);
  const firstRunHistory = []; // Separate history for onboarding conversation
  const bg = new BackgroundRunner();

  // Auth middleware
  bot.use(async (ctx, next) => {
    if (allowedUsers.size > 0 && !allowedUsers.has(ctx.from?.id)) {
      return; // Silently ignore unauthorized users
    }
    await next();
  });

  // Set bot commands menu
  bot.api.setMyCommands([
    { command: 'tasks', description: 'Show running background tasks' },
    { command: 'status', description: 'Bot status and uptime' },
    { command: 'backup', description: 'Trigger GitHub backup now' },
    { command: 'recent', description: 'Show recent memories' },
    { command: 'today', description: 'What happened today' },
  ]).catch(() => {}); // Best effort

  // Handle /start
  bot.command('start', async (ctx) => {
    await ctx.reply('🪙 OBOL is ready. Just send me a message.');
  });

  // Handle /memory commands
  bot.command('memory', async (ctx) => {
    if (!memory) return ctx.reply('Memory not configured.');
    const args = ctx.message.text.split(' ').slice(1);
    const sub = args[0];

    if (sub === 'search' && args[1]) {
      const results = await memory.search(args.slice(1).join(' '));
      if (results.length === 0) return ctx.reply('No memories found.');
      const text = results.map((m, i) =>
        `${i + 1}. [${m.category}] ${m.content.substring(0, 100)}`
      ).join('\n');
      return ctx.reply(`🔍 Found ${results.length}:\n\n${text}`);
    }

    if (sub === 'stats') {
      const stats = await memory.stats();
      return ctx.reply(`📊 ${stats.total} memories\n\n${stats.breakdown}`);
    }

    return ctx.reply('Usage: /memory search <query> | /memory stats');
  });

  // Handle /status
  bot.command('status', async (ctx) => {
    const uptime = process.uptime();
    const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const running = bg.getStatus();

    let text = `🪙 OBOL Status\n\n`;
    text += `⏱️ Uptime: ${h}h ${m}m\n`;
    text += `💾 Memory: ${mem}MB\n`;
    text += `⚡ Tasks: ${running.length} running\n`;

    if (memory) {
      const stats = await memory.stats().catch(() => null);
      if (stats) text += `🧠 Memories: ${stats.total}`;
    }

    await ctx.reply(text);
  });

  // Handle /backup
  bot.command('backup', async (ctx) => {
    try {
      const config = loadConfig();
      if (!config?.github) return ctx.reply('GitHub backup not configured.');
      const { runBackup } = require('./backup');
      await ctx.reply('📦 Running backup...');
      await runBackup(config.github);
      await ctx.reply('✅ Backup complete');
    } catch (e) {
      await ctx.reply(`⚠️ Backup failed: ${e.message}`);
    }
  });

  // Handle /forget
  bot.command('forget', async (ctx) => {
    if (!memory) return ctx.reply('Memory not configured.');
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /forget <memory-id>');
    try {
      await memory.forget(id);
      await ctx.reply(`🗑️ Forgotten: ${id}`);
    } catch (e) {
      await ctx.reply(`⚠️ ${e.message}`);
    }
  });

  // Handle /recent
  bot.command('recent', async (ctx) => {
    if (!memory) return ctx.reply('Memory not configured.');
    const results = await memory.recent({ limit: 10 });
    if (results.length === 0) return ctx.reply('No memories yet.');
    const text = results.map((m, i) => {
      const time = new Date(m.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return `${i + 1}. [${time}] [${m.category}] ${m.content.substring(0, 80)}`;
    }).join('\n');
    await ctx.reply(`🕐 Recent memories:\n\n${text}`);
  });

  // Handle /today
  bot.command('today', async (ctx) => {
    if (!memory) return ctx.reply('Memory not configured.');
    const results = await memory.byDate('today', { limit: 20 });
    if (results.length === 0) return ctx.reply('Nothing stored today yet.');
    const text = results.map((m, i) => {
      const time = new Date(m.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return `${i + 1}. [${time}] [${m.category}] ${m.content.substring(0, 80)}`;
    }).join('\n');
    await ctx.reply(`📅 Today (${results.length} memories):\n\n${text}`);
  });

  // Handle /tasks — show running background tasks
  bot.command('tasks', async (ctx) => {
    const running = bg.getStatus();
    if (running.length === 0) {
      return ctx.reply('No background tasks running.');
    }
    const text = running.map(t =>
      `⏳ #${t.id}: ${t.task}... (${t.elapsed})`
    ).join('\n');
    return ctx.reply(`Running tasks:\n\n${text}`);
  });

  // Handle all text messages
  bot.on('message:text', async (ctx) => {
    const userMessage = ctx.message.text;
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || 'User';

    try {
      // Show typing indicator
      await ctx.replyWithChatAction('typing');

      let response;

      // First-run onboarding — OBOL learns about the user through conversation
      if (isFirstRun()) {
        firstRunHistory.push({ role: 'user', content: userMessage });

        const msg = await claude.client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: FIRST_RUN_SYSTEM,
          messages: firstRunHistory,
        });

        const fullText = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        firstRunHistory.push({ role: 'assistant', content: fullText });

        // Check if OBOL has gathered enough info
        const setup = parseSetupResponse(fullText);
        if (setup?.ready) {
          const config = loadConfig();
          writePersonalityFromSetup(setup, config?.bot?.name);
          markFirstRunComplete();
          // Reload personality in claude instance
          claude.reloadPersonality?.();

          // Run post-setup tasks (pass, swap, firewall)
          if (!isPostSetupDone()) {
            const config = loadConfig({ resolve: false });
            await runPostSetup(config, async (msg) => {
              await ctx.reply(msg).catch(() => {});
            });
          }
        }

        response = cleanResponse(fullText);
      } else {
        // Normal operation
        response = await claude.chat(userMessage, {
          userId,
          userName,
          chatId: ctx.chat.id,
          bg,
          ctx,
        });
      }

      // Send response (split if too long)
      if (response.length > 4096) {
        const chunks = splitMessage(response, 4096);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() =>
            ctx.reply(chunk) // Fallback without markdown if parsing fails
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

  // Handle photos/documents
  bot.on('message:photo', async (ctx) => {
    await ctx.reply('📷 Image support coming soon.');
  });

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
    // Find last newline before limit
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

module.exports = { createBot };
