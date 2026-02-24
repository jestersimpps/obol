const path = require('path');
const { execSync } = require('child_process');
const { Bot, GrammyError, HttpError, InlineKeyboard } = require('grammy');
const { loadConfig } = require('./config');
const { evolve, loadEvolutionState } = require('./evolve');
const { getTenant } = require('./tenant');
const { loadTraits, saveTraits, DEFAULT_TRAITS } = require('./personality');
const media = require('./media');
const credentials = require('./credentials');
const { getMaxToolIterations, setMaxToolIterations, OPTIONAL_TOOLS } = require('./claude');
const { buildStatusHtml, describeToolCall, TERM_WIDTH } = require('./status');
const pkg = require('../package.json');

const RATE_LIMIT_MS = 3000;
const SPAM_THRESHOLD = 5;
const SPAM_COOLDOWN_MS = 30000;
const EVOLUTION_IDLE_MS = 15 * 60 * 1000;
const DEDUP_TTL_MS = 5 * 60 * 1000;
const DEDUP_MAX_SIZE = 2000;
const TEXT_BUFFER_GAP_MS = 1500;
const TEXT_BUFFER_MAX_PARTS = 12;
const TEXT_BUFFER_MAX_CHARS = 50000;
const TEXT_BUFFER_THRESHOLD = 4000;
const MEDIA_GROUP_DELAY_MS = 500;
const TERM_SEP = '━'.repeat(TERM_WIDTH);

const _evolutionTimers = new Map();

function termBar(pct, width = 20) {
  const filled = Math.round((pct / 100) * width);
  return '━'.repeat(filled) + '╌'.repeat(width - filled);
}

function markdownToTelegramHtml(text) {
  const codeBlocks = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    codeBlocks.push(`<pre>${escaped}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  const inlineCode = [];
  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCode.length;
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    inlineCode.push(`<code>${escaped}</code>`);
    return `\x00IC${idx}\x00`;
  });

  result = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');
  result = result.replace(/(?<!\w)\*([^\s*](?:.*?[^\s*])?)\*(?!\w)/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_([^\s_](?:.*?[^\s_])?)_(?!\w)/g, '<i>$1</i>');

  result = result.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCode[parseInt(idx)]);

  return result;
}

function sendHtml(ctx, text, extra = {}) {
  const html = markdownToTelegramHtml(text);
  return ctx.reply(html, { parse_mode: 'HTML', ...extra }).catch(() => ctx.reply(text, extra));
}

function editHtml(ctx, chatId, messageId, text, extra = {}) {
  const html = markdownToTelegramHtml(text);
  return ctx.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML', ...extra })
    .catch(() => ctx.api.editMessageText(chatId, messageId, text, extra));
}

function startTyping(ctx) {
  ctx.replyWithChatAction('typing').catch(() => {});
  const interval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

function createBot(telegramConfig, config) {
  const bot = new Bot(telegramConfig.token);
  const allowedUsers = new Set(telegramConfig.allowedUsers || []);
  const rateLimits = new Map();
  const pendingAsks = new Map();
  const processedUpdates = new Map();
  const textBuffers = new Map();
  const mediaGroups = new Map();
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

  const _rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, val] of rateLimits) {
      if (now - val.lastMessage > 300000) rateLimits.delete(key);
    }
  }, 600000);
  _rateLimitCleanup.unref();

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

  bot.command('start', async (ctx) => {
    await ctx.reply(`<pre>◈ OBOL v${pkg.version}\n${TERM_SEP}\nSYSTEM ONLINE\n${TERM_SEP}</pre>`, { parse_mode: 'HTML' });
  });

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

  bot.command('new', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    tenant.claude.clearHistory(ctx.chat.id);
    await ctx.reply(`<pre>◈ CONTEXT CLEARED\n${TERM_SEP}</pre>`, { parse_mode: 'HTML' });
  });

  bot.command('status', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    const uptime = process.uptime();
    const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const running = tenant.bg.getStatus();

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
    const threshold = cfg?.evolution?.exchanges || 100;
    const evoCount = evoState.exchangesSinceLastEvolution || 0;
    const evoPct = Math.min(100, Math.round((evoCount / threshold) * 100));
    lines.push(
      ``, `EVOLUTION`,
      `  ${termBar(evoPct)} ${evoPct}%`,
      `  ${evoCount}/${threshold} exchanges ▪ ${evoState.evolutionCount || 0} completed`,
    );

    const personalityDir = path.join(tenant.userDir, 'personality');
    const traits = loadTraits(personalityDir);
    lines.push(``, `TRAITS`);
    lines.push(formatTraits(traits));
    lines.push(TERM_SEP);

    await ctx.reply(`<pre>${lines.join('\n')}</pre>`, { parse_mode: 'HTML' });
  });

  bot.command('backup', async (ctx) => {
    if (!ctx.from) return;
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

  bot.command('clean', async (ctx) => {
    if (!ctx.from) return;
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

  bot.command('traits', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    const personalityDir = path.join(tenant.userDir, 'personality');
    const args = ctx.message.text.split(' ').slice(1);

    if (args[0] === 'reset') {
      saveTraits(personalityDir, { ...DEFAULT_TRAITS });
      tenant.claude.reloadPersonality();
      const traits = { ...DEFAULT_TRAITS };
      const lines = [`◈ OBOL PERSONALITY MATRIX`, TERM_SEP, `RESET TO DEFAULTS`, ``, formatTraits(traits), TERM_SEP];
      await ctx.reply(`<pre>${lines.join('\n')}</pre>`, { parse_mode: 'HTML' });
      return;
    }

    if (args[0] && args[1]) {
      const traitName = args[0].toLowerCase();
      const value = parseInt(args[1], 10);
      if (!(traitName in DEFAULT_TRAITS)) {
        await ctx.reply(`Unknown trait: ${traitName}\nValid: ${Object.keys(DEFAULT_TRAITS).join(', ')}`);
        return;
      }
      if (isNaN(value) || value < 0 || value > 100) {
        await ctx.reply('Value must be 0-100');
        return;
      }
      const traits = loadTraits(personalityDir);
      traits[traitName] = value;
      saveTraits(personalityDir, traits);
      tenant.claude.reloadPersonality();
      const lines = [`◈ OBOL PERSONALITY MATRIX`, TERM_SEP, `UPDATED ${traitName} → ${value}`, ``, formatTraits(traits), TERM_SEP];
      await ctx.reply(`<pre>${lines.join('\n')}</pre>`, { parse_mode: 'HTML' });
      return;
    }

    const traits = loadTraits(personalityDir);
    const lines = [`◈ OBOL PERSONALITY MATRIX`, TERM_SEP, ``, formatTraits(traits), ``, `/traits &lt;name&gt; &lt;0-100&gt;`, `/traits reset`, TERM_SEP];
    await ctx.reply(`<pre>${lines.join('\n')}</pre>`, { parse_mode: 'HTML' });
  });

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

  bot.command('evolution', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    const state = loadEvolutionState(tenant.userDir);
    const cfg = loadConfig();
    const threshold = cfg?.evolution?.exchanges || 100;
    const count = state.exchangesSinceLastEvolution || 0;
    const pct = Math.min(100, Math.round((count / threshold) * 100));

    const lines = [
      `◈ OBOL EVOLUTION CYCLE`,
      TERM_SEP,
      ``,
      `  ${termBar(pct)} ${pct}%`,
      `  ${count}/${threshold} exchanges`,
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
    try {
      const events = await tenant.scheduler.list({ status: 'pending' });
      if (events.length === 0) return ctx.reply('No upcoming events.');
      const text = events.map((e, i) => {
        const tz = e.timezone || 'UTC';
        const dueLocal = new Date(e.due_at).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
        return `${i + 1}. *${e.title}*\n   ${dueLocal} (${tz})\n   \`${e.id}\``;
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
/tools — Toggle optional tools on/off
/traits — View/adjust personality traits
/secret — Manage per-user secrets
/evolution — Evolution progress
/status — Bot status and uptime
/backup — Trigger GitHub backup
/clean — Audit workspace
/verbose — Toggle verbose mode on/off
/toolimit — View or set max tool iterations
/stop — Stop the current request
/upgrade — Check for updates and upgrade
/help — This message`);
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

  bot.command('upgrade', async (ctx) => {
    const current = pkg.version;
    let latest;
    try {
      latest = execSync(`npm view ${pkg.name} version`, { encoding: 'utf-8' }).trim();
    } catch {
      await ctx.reply('Could not reach npm registry');
      return;
    }

    if (current === latest) {
      await ctx.reply(`Already on latest (${current})`);
      return;
    }

    await ctx.reply(`Upgrading ${current} → ${latest}, back in a moment...`);

    try {
      execSync(`npm install -g ${pkg.name}@latest`, { encoding: 'utf-8', timeout: 120000 });
      const { OBOL_DIR } = require('./config');
      const notifyPath = path.join(OBOL_DIR, '.upgrade-notify.json');
      fs.writeFileSync(notifyPath, JSON.stringify({ chatId: ctx.chat.id, version: latest }));
      execSync('pm2 restart obol', { encoding: 'utf-8', timeout: 15000 });
    } catch (e) {
      await ctx.reply(`Upgrade failed: ${e.message.substring(0, 200)}`);
    }
  });

  bot.command('toolimit', async (ctx) => {
    if (!ctx.from) return;
    const args = ctx.message.text.split(' ').slice(1);
    const current = getMaxToolIterations();

    if (!args[0]) {
      await ctx.reply(`🔧 Max tool iterations: ${current}\n\nThis limits how many tool calls OBOL can make per message. Higher = more complex tasks, but slower responses.\n\nSet: /toolimit <number>\nExample: /toolimit 50`);
      return;
    }

    const value = parseInt(args[0], 10);
    if (isNaN(value) || value < 1 || value > 500) {
      await ctx.reply(`Invalid value: "${args[0]}"\n\nMust be a number between 1 and 500.\nCurrent: ${current}\n\nExample: /toolimit 50`);
      return;
    }

    setMaxToolIterations(value);
    await ctx.reply(`🔧 Max tool iterations set to ${value}`);
  });

  function buildToolsMessage(toolPrefs) {
    const lines = [`◈ TOOLS`, TERM_SEP, ``];
    for (const [key, feature] of Object.entries(OPTIONAL_TOOLS)) {
      const pref = toolPrefs.get(key);
      const enabled = pref?.enabled || false;
      lines.push(`  ${enabled ? '◉' : '○'} ${feature.label}`);
    }
    lines.push(``, TERM_SEP);
    return lines.join('\n');
  }

  function buildToolsKeyboard(toolPrefs) {
    const keyboard = new InlineKeyboard();
    const entries = Object.entries(OPTIONAL_TOOLS);
    for (let i = 0; i < entries.length; i++) {
      const [key, feature] = entries[i];
      const pref = toolPrefs.get(key);
      const enabled = pref?.enabled || false;
      keyboard.text(`${enabled ? '◉' : '○'} ${feature.label}`, `tool:${key}`);
      if ((i + 1) % 2 === 0 && i < entries.length - 1) keyboard.row();
    }
    return keyboard;
  }

  bot.command('tools', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    await tenant.reloadToolPrefs();
    const text = buildToolsMessage(tenant.toolPrefs);
    const keyboard = buildToolsKeyboard(tenant.toolPrefs);
    await ctx.reply(`<pre>${text}</pre>`, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  function checkRateLimit(userId) {
    const now = Date.now();
    const userLimit = rateLimits.get(userId) || { lastMessage: 0, spamCount: 0, cooldownUntil: 0 };
    if (now < userLimit.cooldownUntil) return 'cooldown';
    if (now - userLimit.lastMessage < RATE_LIMIT_MS) {
      userLimit.spamCount++;
      userLimit.lastMessage = now;
      rateLimits.set(userId, userLimit);
      if (userLimit.spamCount >= SPAM_THRESHOLD) {
        userLimit.cooldownUntil = now + SPAM_COOLDOWN_MS;
        rateLimits.set(userId, userLimit);
        return 'spam';
      }
      return userLimit.spamCount === 1 ? 'slow' : 'skip';
    }
    userLimit.lastMessage = now;
    userLimit.spamCount = 0;
    rateLimits.set(userId, userLimit);
    return null;
  }

  const API_KEY_PATTERNS = [
    /sk-[a-zA-Z0-9]{20,}/,
    /ghp_[a-zA-Z0-9]{36,}/,
    /gho_[a-zA-Z0-9]{36,}/,
    /ghu_[a-zA-Z0-9]{36,}/,
    /ghs_[a-zA-Z0-9]{36,}/,
    /github_pat_[a-zA-Z0-9_]{20,}/,
    /xoxb-[a-zA-Z0-9\-]{20,}/,
    /xoxp-[a-zA-Z0-9\-]{20,}/,
    /xoxs-[a-zA-Z0-9\-]{20,}/,
    /AKIA[A-Z0-9]{16}/,
    /eyJ[a-zA-Z0-9_-]{50,}/,
  ];

  function containsApiKey(text) {
    return API_KEY_PATTERNS.some(pattern => pattern.test(text));
  }

  async function processTextMessage(ctx, fullMessage) {
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || 'User';
    const tenant = await getTenant(userId, config);

    if (_evolutionTimers.has(userId)) {
      clearTimeout(_evolutionTimers.get(userId));
      _evolutionTimers.delete(userId);
      if (tenant.messageLog) tenant.messageLog._evolutionPending = false;
    }

    let replyContext = '';
    const reply = ctx.message?.reply_to_message;
    if (reply) {
      const quote = (reply.text || reply.caption || '').substring(0, 500);
      const sender = reply.from
        ? (reply.from.first_name || '') + (reply.from.last_name ? ` ${reply.from.last_name}` : '')
        : reply.forward_origin?.sender_user?.first_name || 'someone';
      if (quote) replyContext = `[Replying to "${quote}" from ${sender}]\n\n`;
    }

    const chatMessage = replyContext + fullMessage;
    const stopTyping = startTyping(ctx);

    let statusMsgId = null;
    let statusText = 'Processing';
    let statusTimer = null;
    let statusStart = null;
    let routeInfo = null;

    const clearStatus = () => {
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      if (statusMsgId) { ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => {}); statusMsgId = null; }
    };

    const startStatusTimer = () => {
      if (statusTimer) return;
      statusStart = Date.now();
      const html = buildStatusHtml({ route: routeInfo, elapsed: 0, toolStatus: statusText });
      ctx.reply(html, { parse_mode: 'HTML' }).then(sent => {
        if (sent) statusMsgId = sent.message_id;
      }).catch(() => {});
      statusTimer = setInterval(() => {
        if (!statusMsgId) return;
        const elapsed = Math.round((Date.now() - statusStart) / 1000);
        const html = buildStatusHtml({ route: routeInfo, elapsed, toolStatus: statusText });
        ctx.api.editMessageText(ctx.chat.id, statusMsgId, html, { parse_mode: 'HTML' }).catch(() => {});
      }, 1000);
    };

    try {
      tenant.messageLog?.log(ctx.chat.id, 'user', chatMessage);

      const chatContext = {
        userId,
        userName,
        chatId: ctx.chat.id,
        bg: tenant.bg,
        ctx,
        claude: tenant.claude,
        scheduler: tenant.scheduler,
        toolPrefs: tenant.toolPrefs,
        config,
        verbose: tenant.verbose,
        _verboseNotify: tenant.verbose ? (msg) => {
          sendHtml(ctx, `\`${msg}\``).catch(() => {});
        } : undefined,
        telegramAsk: (message, options, timeout) => createAsk(ctx, message, options, timeout),
        _notifyFn: (targetUserId, message) => {
          if (!allowedUsers.has(targetUserId)) throw new Error('Cannot notify user outside allowed list');
          return bot.api.sendMessage(targetUserId, message);
        },
        _onRouteDecision: (info) => {
          routeInfo = info;
          startStatusTimer();
        },
        _onRouteUpdate: (update) => {
          if (routeInfo) routeInfo.memoryCount = update.memoryCount;
        },
        _onToolStart: (toolName, inputSummary) => {
          statusText = 'Processing';
          describeToolCall(tenant.claude.client, toolName, inputSummary).then(desc => {
            if (desc) statusText = desc;
          });
          startStatusTimer();
        },
      };
      const { text: response, usage, model } = await tenant.claude.chat(chatMessage, chatContext);

      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
        if (statusMsgId) {
          const elapsed = statusStart ? Math.round((Date.now() - statusStart) / 1000) : 0;
          const html = buildStatusHtml({ route: routeInfo, elapsed, toolStatus: 'Formatting output' });
          ctx.api.editMessageText(ctx.chat.id, statusMsgId, html, { parse_mode: 'HTML' }).catch(() => {});
        }
      }

      if (!response?.trim()) {
        stopTyping();
        clearStatus();
        return;
      }

      tenant.messageLog?.log(ctx.chat.id, 'assistant', response, { model, tokensIn: usage?.input_tokens, tokensOut: usage?.output_tokens });

      if (tenant.messageLog?._evolutionReady && !_evolutionTimers.has(userId)) {
        tenant.messageLog._evolutionReady = false;
        tenant.messageLog._evolutionPending = true;
        const timer = setTimeout(async () => {
          _evolutionTimers.delete(userId);
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

            await sendHtml(ctx, msg).catch(() => {});
          } catch (e) {
            console.error('Evolution failed:', e.message);
          } finally {
            tenant.messageLog._evolutionPending = false;
          }
        }, EVOLUTION_IDLE_MS);
        _evolutionTimers.set(userId, timer);
      }

      stopTyping();

      if (response.length > 4096) {
        const chunks = splitMessage(response, 4096);
        for (const chunk of chunks) {
          await sendHtml(ctx, chunk).catch(() => {});
        }
      } else {
        await sendHtml(ctx, response).catch(() => {});
      }

      if (usage && model) {
        const tag = model.includes('opus') ? 'opus' : model.includes('haiku') ? 'haiku' : 'sonnet';
        const tokIn = usage.input_tokens >= 1000 ? `${(usage.input_tokens/1000).toFixed(1)}k` : usage.input_tokens;
        const tokOut = usage.output_tokens >= 1000 ? `${(usage.output_tokens/1000).toFixed(1)}k` : usage.output_tokens;
        const dur = statusStart ? ((Date.now() - statusStart)/1000).toFixed(1) : null;
        const parts = [`◈ ${tag}`, `${tokIn} in`, `${tokOut} out`];
        if (dur) parts.push(`${dur}s`);
        await ctx.reply(`<code>${parts.join(' ▪ ')}</code>`, { parse_mode: 'HTML' }).catch(() => {});
      }

      if (statusMsgId) ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => {});
    } catch (e) {
      clearStatus();
      stopTyping();
      console.error('Message handling error:', e.message);
      const errMsg = e.isOAuthExpiry
        ? `OAuth error: ${e.message}\n\nRun \`obol config\` → Anthropic → re-authenticate OAuth.`
        : (e.status === 401 || e.message?.includes('401'))
          ? 'API key invalid or expired. Run `obol config` to update.'
          : (e.status === 429 || e.message?.includes('rate'))
            ? 'Rate limited. Wait a moment and try again.'
            : 'Something went wrong. Check logs with `obol logs`.';
      if (e.isOAuthExpiry) console.error('[oauth] Full error:', e.stack || e.message);
      await ctx.reply(errMsg).catch(() => {});
    }
  }

  function flushTextBuffer(chatId, ctx) {
    const buf = textBuffers.get(chatId);
    if (!buf) return;
    clearTimeout(buf.timer);
    textBuffers.delete(chatId);
    const combined = buf.parts.join('');
    processTextMessage(ctx, combined).catch(e => console.error('Buffer flush error:', e.message));
  }

  bot.on('message:text', async (ctx) => {
    if (!ctx.from) return;
    const userMessage = ctx.message.text;
    if (!userMessage || !userMessage.trim()) return;
    const userId = ctx.from.id;

    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
      const me = await bot.api.getMe();
      if (!userMessage.includes(`@${me.username}`)) return;
    }

    if (!userMessage.startsWith('/secret') && containsApiKey(userMessage)) {
      ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      await ctx.reply(
        '⚠️ That message contained what looks like an API key or token. I deleted it, but it may have been seen already — consider rotating it.\n\nUse `/secret set <name> <value>` to store credentials safely.'
      ).catch(() => {});
      return;
    }

    const rateResult = checkRateLimit(userId);
    if (rateResult === 'cooldown' || rateResult === 'skip') return;
    if (rateResult === 'spam') {
      await ctx.reply('Spam detected. Cooling down for 30 seconds.').catch(() => {});
      return;
    }
    if (rateResult === 'slow') {
      await ctx.reply('Slow down a bit — I\'m still processing.').catch(() => {});
      return;
    }

    const chatId = ctx.chat.id;
    const existingBuf = textBuffers.get(chatId);

    if (userMessage.length >= TEXT_BUFFER_THRESHOLD) {
      if (existingBuf) {
        clearTimeout(existingBuf.timer);
        if (existingBuf.parts.length < TEXT_BUFFER_MAX_PARTS &&
            existingBuf.totalLength + userMessage.length <= TEXT_BUFFER_MAX_CHARS) {
          existingBuf.parts.push(userMessage);
          existingBuf.totalLength += userMessage.length;
          existingBuf.ctx = ctx;
          existingBuf.timer = setTimeout(() => flushTextBuffer(chatId, ctx), TEXT_BUFFER_GAP_MS);
          return;
        }
        flushTextBuffer(chatId, ctx);
      }
      const buf = {
        parts: [userMessage],
        totalLength: userMessage.length,
        ctx,
        timer: setTimeout(() => flushTextBuffer(chatId, ctx), TEXT_BUFFER_GAP_MS),
      };
      textBuffers.set(chatId, buf);
      return;
    }

    if (existingBuf) {
      flushTextBuffer(chatId, existingBuf.ctx);
    }

    await processTextMessage(ctx, userMessage);
  });

  const MAX_MEDIA_SIZE = 50 * 1024 * 1024;

  async function downloadMediaItem(ctx, fileInfo) {
    const file = await ctx.getFile();
    const buffer = await media.downloadFile(telegramConfig.token, file.file_path);
    const filename = media.generateFilename(fileInfo, file.file_path);
    return { buffer, filename, fileInfo, caption: ctx.message.caption || '' };
  }

  async function processMediaItems(ctx, items) {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const stopTyping = startTyping(ctx);
    let statusMsgId = null;
    let statusText = 'Processing';
    let statusTimer = null;
    let statusStart = null;
    let routeInfo = null;

    const clearStatus = () => {
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      if (statusMsgId) { ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => {}); statusMsgId = null; }
    };

    const startStatusTimer = () => {
      if (statusTimer) return;
      statusStart = Date.now();
      const html = buildStatusHtml({ route: routeInfo, elapsed: 0, toolStatus: statusText });
      ctx.reply(html, { parse_mode: 'HTML' }).then(sent => {
        if (sent) statusMsgId = sent.message_id;
      }).catch(() => {});
      statusTimer = setInterval(() => {
        if (!statusMsgId) return;
        const elapsed = Math.round((Date.now() - statusStart) / 1000);
        const html = buildStatusHtml({ route: routeInfo, elapsed, toolStatus: statusText });
        ctx.api.editMessageText(ctx.chat.id, statusMsgId, html, { parse_mode: 'HTML' }).catch(() => {});
      }, 1000);
    };

    try {
      const tenant = await getTenant(userId, config);
      const assetsDir = path.join(tenant.userDir, 'assets');
      const imageBlocks = [];
      const nonImageParts = [];
      const caption = items.map(i => i.caption).filter(Boolean).join('\n') || '';

      for (const item of items) {
        const savedPath = media.saveFile(item.buffer, assetsDir, item.filename);

        if (tenant.memory && !media.isImage(item.fileInfo)) {
          const memContent = media.buildMemoryContent(item.fileInfo, item.filename, savedPath, item.caption);
          await tenant.memory.add(memContent, {
            category: 'resource', importance: 0.6,
            source: 'telegram-media', tags: [item.fileInfo.mediaType],
          }).catch(() => {});
        }

        if (media.isImage(item.fileInfo)) {
          imageBlocks.push(media.bufferToImageBlock(item.buffer, item.fileInfo.mimeType));
        } else {
          nonImageParts.push(item.caption
            ? `[User sent a ${item.fileInfo.mediaType}: ${item.filename}, saved at ${savedPath}] ${item.caption}`
            : `[User sent a ${item.fileInfo.mediaType}: ${item.filename}, saved at ${savedPath}. Use read_file to read its contents if needed.]`);
        }
      }

      let prompt, chatImages;
      if (imageBlocks.length > 0) {
        prompt = caption || `The user sent ${imageBlocks.length} image(s). Describe what you see and respond naturally.`;
        if (nonImageParts.length > 0) prompt += '\n\n' + nonImageParts.join('\n');
        chatImages = imageBlocks;
      } else {
        prompt = nonImageParts.join('\n');
      }

      const mediaChatCtx = {
        userId,
        userName: ctx.from.first_name || 'User',
        chatId: ctx.chat.id,
        bg: tenant.bg, ctx, claude: tenant.claude,
        scheduler: tenant.scheduler, toolPrefs: tenant.toolPrefs, config,
        verbose: tenant.verbose,
        _verboseNotify: tenant.verbose ? (msg) => {
          sendHtml(ctx, `\`${msg}\``).catch(() => {});
        } : undefined,
        ...(chatImages ? { images: chatImages } : {}),
        _notifyFn: (targetUserId, message) => {
          if (!allowedUsers.has(targetUserId)) throw new Error('Cannot notify user outside allowed list');
          return bot.api.sendMessage(targetUserId, message);
        },
        _onRouteDecision: (info) => {
          routeInfo = info;
          startStatusTimer();
        },
        _onRouteUpdate: (update) => {
          if (routeInfo) routeInfo.memoryCount = update.memoryCount;
        },
        _onToolStart: (toolName, inputSummary) => {
          statusText = 'Processing';
          describeToolCall(tenant.claude.client, toolName, inputSummary).then(desc => {
            if (desc) statusText = desc;
          });
          startStatusTimer();
        },
      };
      const { text: response, usage, model } = await tenant.claude.chat(prompt, mediaChatCtx);

      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
        if (statusMsgId) {
          const elapsed = statusStart ? Math.round((Date.now() - statusStart) / 1000) : 0;
          const html = buildStatusHtml({ route: routeInfo, elapsed, toolStatus: 'Formatting output' });
          ctx.api.editMessageText(ctx.chat.id, statusMsgId, html, { parse_mode: 'HTML' }).catch(() => {});
        }
      }

      stopTyping();
      if (!response?.trim()) {
        clearStatus();
        return;
      }

      const logLabel = items.map(i => `[${i.fileInfo.mediaType}] ${i.caption || i.filename}`).join(', ');
      tenant.messageLog?.log(ctx.chat.id, 'user', logLabel);
      tenant.messageLog?.log(ctx.chat.id, 'assistant', response, { model, tokensIn: usage?.input_tokens, tokensOut: usage?.output_tokens });

      if (tenant.memory && imageBlocks.length > 0) {
        const filenames = items.filter(i => media.isImage(i.fileInfo)).map(i => i.filename).join(', ');
        const analysisMemory = `Images: ${filenames}${caption ? `. Caption: "${caption}"` : ''}. Analysis: ${response.substring(0, 1500)}`;
        await tenant.memory.add(analysisMemory, {
          category: 'resource', importance: 0.7,
          source: 'image-analysis',
          tags: ['image', ...(caption ? caption.toLowerCase().split(/\s+/).slice(0, 3) : [])],
        }).catch(() => {});
      }

      if (response.length > 4096) {
        const chunks = splitMessage(response, 4096);
        for (const chunk of chunks) await sendHtml(ctx, chunk).catch(() => {});
      } else {
        await sendHtml(ctx, response).catch(() => {});
      }

      if (usage && model) {
        const tag = model.includes('opus') ? 'opus' : model.includes('haiku') ? 'haiku' : 'sonnet';
        const tokIn = usage.input_tokens >= 1000 ? `${(usage.input_tokens/1000).toFixed(1)}k` : usage.input_tokens;
        const tokOut = usage.output_tokens >= 1000 ? `${(usage.output_tokens/1000).toFixed(1)}k` : usage.output_tokens;
        const dur = statusStart ? ((Date.now() - statusStart)/1000).toFixed(1) : null;
        const parts = [`◈ ${tag}`, `${tokIn} in`, `${tokOut} out`];
        if (dur) parts.push(`${dur}s`);
        await ctx.reply(`<code>${parts.join(' ▪ ')}</code>`, { parse_mode: 'HTML' }).catch(() => {});
      }

      if (statusMsgId) ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => {});
    } catch (e) {
      clearStatus();
      stopTyping();
      console.error('Media handling error:', e.message);
      await ctx.reply('Failed to process that file. Check logs.').catch(() => {});
    }
  }

  async function handleMedia(ctx) {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const rateResult = checkRateLimit(userId);
    if (rateResult) return;
    const fileInfo = media.getFileInfo(ctx);
    if (!fileInfo) return;

    if (fileInfo.fileSize > MAX_MEDIA_SIZE) {
      await ctx.reply(`File too large (${(fileInfo.fileSize / 1024 / 1024).toFixed(1)}MB). Max is 50MB.`).catch(() => {});
      return;
    }

    const item = await downloadMediaItem(ctx, fileInfo).catch(e => {
      console.error('Media download error:', e.message);
      return null;
    });
    if (!item) return;

    const groupId = ctx.message.media_group_id;
    if (groupId) {
      const existing = mediaGroups.get(groupId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.items.push(item);
        existing.ctx = ctx;
        existing.timer = setTimeout(() => {
          mediaGroups.delete(groupId);
          processMediaItems(existing.ctx, existing.items).catch(e =>
            console.error('Media group error:', e.message)
          );
        }, MEDIA_GROUP_DELAY_MS);
      } else {
        const group = {
          items: [item],
          ctx,
          timer: setTimeout(() => {
            mediaGroups.delete(groupId);
            processMediaItems(ctx, [item]).catch(e =>
              console.error('Media group error:', e.message)
            );
          }, MEDIA_GROUP_DELAY_MS),
        };
        mediaGroups.set(groupId, group);
      }
      return;
    }

    await processMediaItems(ctx, [item]);
  }

  bot.on('message:photo', handleMedia);
  bot.on('message:document', handleMedia);
  bot.on('message:voice', handleMedia);
  bot.on('message:video', handleMedia);
  bot.on('message:audio', handleMedia);
  bot.on('message:sticker', handleMedia);
  bot.on('message:animation', handleMedia);
  bot.on('message:video_note', handleMedia);

  const VOICE_LANGUAGES = [
    { code: 'en-US', label: 'English (US)' },
    { code: 'en-GB', label: 'English (UK)' },
    { code: 'en-AU', label: 'English (AU)' },
    { code: 'fr-FR', label: 'French' },
    { code: 'de-DE', label: 'German' },
    { code: 'es-ES', label: 'Spanish' },
    { code: 'it-IT', label: 'Italian' },
    { code: 'pt-BR', label: 'Portuguese (BR)' },
    { code: 'nl-NL', label: 'Dutch' },
    { code: 'ja-JP', label: 'Japanese' },
    { code: 'ko-KR', label: 'Korean' },
    { code: 'zh-CN', label: 'Chinese' },
  ];

  const TTS_SAMPLE = 'Hello! This is what I sound like. Nice to meet you.';

  function sendVoiceLanguagePicker(ctx) {
    const kb = new InlineKeyboard();
    for (const lang of VOICE_LANGUAGES) {
      kb.text(lang.label, `voice:lang:${lang.code}`).row();
    }
    ctx.reply('Pick a language:', { reply_markup: kb }).catch(() => {});
  }

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const answer = (opts) => ctx.answerCallbackQuery(opts).catch(() => {});

    if (data.startsWith('tool:')) {
      const featureKey = data.slice(5);
      if (!OPTIONAL_TOOLS[featureKey]) return answer({ text: 'Unknown tool' });
      if (!ctx.from) return answer();

      const tenant = await getTenant(ctx.from.id, config);
      if (!tenant.toolPrefsApi) return answer({ text: 'Not available' });

      const newEnabled = await tenant.toolPrefsApi.toggle(featureKey);
      await tenant.reloadToolPrefs();

      const feature = OPTIONAL_TOOLS[featureKey];
      await answer({ text: `${feature.label}: ${newEnabled ? 'ON' : 'OFF'}` });

      const text = buildToolsMessage(tenant.toolPrefs);
      const keyboard = buildToolsKeyboard(tenant.toolPrefs);
      ctx.editMessageText(`<pre>${text}</pre>`, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});

      if (newEnabled && Object.keys(feature.config).length > 0 && feature.config.voice) {
        sendVoiceLanguagePicker(ctx);
      }
      return;
    }

    if (data.startsWith('voice:')) {
      if (!ctx.from) return answer();
      const parts = data.split(':');
      const action = parts[1];

      if (action === 'lang') {
        const langCode = parts[2];
        await answer({ text: langCode });
        const tts = require('./tts');
        try {
          const voices = await tts.getVoices(langCode);
          if (voices.length === 0) return sendHtml(ctx, 'No voices found for that language.');
          const kb = new InlineKeyboard();
          for (const v of voices) {
            const glyph = v.gender === 'Female' ? '♀' : '♂';
            const shortLabel = v.name.replace('Neural', '').replace('Multilingual', 'ML');
            kb.text(`${glyph} ${shortLabel}`, `voice:pick:${v.name}`).row();
          }
          kb.text('← Back', 'voice:langs').row();
          ctx.editMessageText('Pick a voice:', { reply_markup: kb }).catch(() => {});
        } catch (e) {
          sendHtml(ctx, `Failed to load voices: ${e.message}`).catch(() => {});
        }
        return;
      }

      if (action === 'langs') {
        await answer();
        const kb = new InlineKeyboard();
        for (const lang of VOICE_LANGUAGES) {
          kb.text(lang.label, `voice:lang:${lang.code}`).row();
        }
        ctx.editMessageText('Pick a language:', { reply_markup: kb }).catch(() => {});
        return;
      }

      if (action === 'pick') {
        const voiceName = parts[2];
        await answer({ text: `Sampling ${voiceName}...` });
        const tts = require('./tts');
        const fs = require('fs');
        try {
          const filePath = await tts.synthesize(TTS_SAMPLE, voiceName);
          const { InputFile } = require('grammy');
          await ctx.replyWithAudio(new InputFile(filePath));
          try { fs.unlinkSync(filePath); } catch {}

          const kb = new InlineKeyboard();
          kb.text('✓ Use this voice', `voice:save:${voiceName}`).row();
          kb.text('← Try another', `voice:langs`).row();
          await ctx.reply(`<b>${voiceName}</b>`, { parse_mode: 'HTML', reply_markup: kb });
        } catch (e) {
          sendHtml(ctx, `Sample failed: ${e.message}`).catch(() => {});
        }
        return;
      }

      if (action === 'save') {
        const voiceName = parts[2];
        await answer({ text: `Voice set: ${voiceName}` });
        const tenant = await getTenant(ctx.from.id, config);
        if (tenant.toolPrefsApi) {
          const pref = tenant.toolPrefs.get('text_to_speech');
          const newConfig = { ...(pref?.config || {}), voice: voiceName };
          await tenant.toolPrefsApi.set('text_to_speech', true, newConfig);
          await tenant.reloadToolPrefs();
        }
        ctx.editMessageText(`<b>✓ ${voiceName}</b>`, { parse_mode: 'HTML' }).catch(() => {});
        return;
      }

      return answer();
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

function formatTraits(traits) {
  const maxLen = Math.max(...Object.keys(traits).map(k => k.length));
  return Object.entries(traits).map(([name, val]) => {
    const label = (name.charAt(0).toUpperCase() + name.slice(1)).padEnd(maxLen + 1);
    return `  ${label}${termBar(val)} ${val}`;
  }).join('\n');
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

async function checkUpgradeNotify(bot) {
  const { OBOL_DIR } = require('./config');
  const notifyPath = path.join(OBOL_DIR, '.upgrade-notify.json');
  if (!fs.existsSync(notifyPath)) return;
  try {
    const { chatId, version } = JSON.parse(fs.readFileSync(notifyPath, 'utf-8'));
    fs.unlinkSync(notifyPath);
    await bot.api.sendMessage(chatId, `🪙 Upgraded to ${version}`);
  } catch {}
}

module.exports = { createBot, checkUpgradeNotify };
