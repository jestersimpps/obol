const fs = require('fs');
const path = require('path');
const { Bot, GrammyError, HttpError, InlineKeyboard } = require('grammy');
const { run, sequentialize } = require('@grammyjs/runner');
const { getTenant } = require('../tenant');
const { DEDUP_TTL_MS, DEDUP_MAX_SIZE } = require('./constants');
const { sendHtml } = require('./utils');

const memoryCommands = require('./commands/memory');
const statusCommands = require('./commands/status');
const conversationCommands = require('./commands/conversation');
const adminCommands = require('./commands/admin');
const traitsCommands = require('./commands/traits');
const secretsCommands = require('./commands/secrets');
const toolsCommands = require('./commands/tools');
const { registerTextHandler } = require('./handlers/text');
const { registerMediaHandler } = require('./handlers/media');
const { registerCallbackHandler } = require('./handlers/callbacks');

function createBot(telegramConfig, config) {
  const bot = new Bot(telegramConfig.token);
  const allowedUsers = new Set(telegramConfig.allowedUsers || []);
  const pendingAsks = new Map();
  const processedUpdates = new Map();
  let askIdCounter = 0;

  function createAsk(ctx, message, options, timeoutSecs = 60) {
    return new Promise((resolve) => {
      const askId = ++askIdCounter;
      const keyboard = new InlineKeyboard();
      options.forEach((opt, i) => {
        keyboard.text(opt, `ask:${askId}:${i}`);
        if ((i + 1) % 3 === 0 && i < options.length - 1) keyboard.row();
      });
      const timer = setTimeout(() => {
        if (pendingAsks.has(askId)) {
          pendingAsks.delete(askId);
          resolve('timeout');
        }
      }, timeoutSecs * 1000);
      pendingAsks.set(askId, { resolve, options, timer });
      sendHtml(ctx, message, { reply_markup: keyboard }).catch(() => {
        clearTimeout(timer);
        pendingAsks.delete(askId);
        resolve('error');
      });
    });
  }

  bot.use(sequentialize((ctx) => {
    if (ctx.callbackQuery?.data?.startsWith('stop:')) return undefined;
    return ctx.chat?.id.toString();
  }));

  bot.use(async (ctx, next) => {
    const updateId = ctx.update?.update_id;
    if (updateId != null) {
      if (processedUpdates.has(updateId)) return;
      processedUpdates.set(updateId, Date.now());
      if (processedUpdates.size > DEDUP_MAX_SIZE) {
        const now = Date.now();
        for (const [id, ts] of processedUpdates) {
          if (now - ts > DEDUP_TTL_MS) processedUpdates.delete(id);
        }
      }
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    if (allowedUsers.size > 0 && !allowedUsers.has(ctx.from?.id)) {
      return;
    }
    await next();
  });

  const pkg = require('../../package.json');
  bot.api.setMyCommands([
    { command: 'new', description: 'Start a fresh conversation' },
    { command: 'memory', description: 'Search or view memory stats' },
    { command: 'recent', description: 'Last 10 memories' },
    { command: 'today', description: "Today's memories" },
    { command: 'events', description: 'Show upcoming scheduled events' },
    { command: 'tasks', description: 'Show running background tasks' },
    { command: 'status', description: 'Bot status and uptime' },
    { command: 'backup', description: 'Trigger GitHub backup now' },
    { command: 'clean', description: 'Audit and fix workspace' },
    { command: 'traits', description: 'View or adjust personality traits' },
    { command: 'secret', description: 'Manage per-user secrets' },
    { command: 'evolution', description: 'Evolution progress' },
    { command: 'verbose', description: 'Toggle verbose mode on/off' },
    { command: 'toolimit', description: 'View or set max tool iterations per message' },
    { command: 'tools', description: 'Toggle optional tools on/off' },
    { command: 'stop', description: 'Stop the current request' },
    { command: 'upgrade', description: 'Check for updates and upgrade' },
    { command: 'help', description: 'Show available commands' },
  ]).catch(() => {});

  conversationCommands.register(bot, config);
  memoryCommands.register(bot, config);
  statusCommands.register(bot, config);
  adminCommands.register(bot, config);
  traitsCommands.register(bot, config);
  secretsCommands.register(bot, config);
  toolsCommands.register(bot, config);

  const deps = { config, allowedUsers, bot, createAsk };
  registerTextHandler(bot, deps);
  registerMediaHandler(bot, telegramConfig, deps);
  registerCallbackHandler(bot, { config, pendingAsks, getTenant });

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

  let runnerHandle = null;

  bot.start = async function startConcurrent(opts = {}) {
    const me = await bot.api.getMe();
    bot.botInfo = me;
    opts.onStart?.(me);

    runnerHandle = run(bot);
    await runnerHandle.task();
  };

  const originalStop = bot.stop.bind(bot);
  bot.stop = async function stopConcurrent() {
    if (runnerHandle) {
      runnerHandle.stop();
      runnerHandle = null;
    }
    await originalStop().catch(() => {});
  };

  return bot;
}

async function checkUpgradeNotify(bot) {
  const { OBOL_DIR } = require('../config');
  const notifyPath = path.join(OBOL_DIR, '.upgrade-notify.json');
  if (!fs.existsSync(notifyPath)) return;
  try {
    const { chatId, version } = JSON.parse(fs.readFileSync(notifyPath, 'utf-8'));
    fs.unlinkSync(notifyPath);
    let msg = `🪙 Upgraded to ${version}`;
    const { getLatestChanges } = require('../cli/changelog');
    const changes = getLatestChanges();
    if (changes) msg += `\n\n${changes}`;
    await bot.api.sendMessage(chatId, msg);
  } catch {}
}

module.exports = { createBot, checkUpgradeNotify };
