const path = require('path');
const { Bot, GrammyError, HttpError, InlineKeyboard } = require('grammy');
const { loadConfig } = require('./config');
const { evolve, loadEvolutionState } = require('./evolve');
const { getTenant } = require('./tenant');
const { loadTraits, saveTraits, DEFAULT_TRAITS } = require('./personality');
const media = require('./media');
const credentials = require('./credentials');
const { getMaxToolIterations, setMaxToolIterations } = require('./claude');

const RATE_LIMIT_MS = 3000;
const SPAM_THRESHOLD = 5;
const SPAM_COOLDOWN_MS = 30000;

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
      ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {
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
    { command: 'tasks', description: 'Show running background tasks' },
    { command: 'status', description: 'Bot status and uptime' },
    { command: 'backup', description: 'Trigger GitHub backup now' },
    { command: 'clean', description: 'Audit and fix workspace' },
    { command: 'traits', description: 'View or adjust personality traits' },
    { command: 'secret', description: 'Manage per-user secrets' },
    { command: 'evolution', description: 'Evolution progress' },
    { command: 'verbose', description: 'Toggle verbose mode on/off' },
    { command: 'toolimit', description: 'View or set max tool iterations per message' },
    { command: 'help', description: 'Show available commands' },
  ]).catch(() => {});

  bot.command('start', async (ctx) => {
    await ctx.reply('🪙 OBOL is ready. Just send me a message.');
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
    await ctx.reply('🪙 Fresh start. What\'s up?');
  });

  bot.command('status', async (ctx) => {
    if (!ctx.from) return;
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
    text += `🔧 Tool limit: ${getMaxToolIterations()}\n`;

    if (tenant.memory) {
      const stats = await tenant.memory.stats().catch(() => null);
      if (stats) text += `🧠 Memories: ${stats.total}\n`;
    }

    const ctxStats = tenant.claude.getContextStats(ctx.chat.id);
    const ctxBar = '█'.repeat(Math.floor(ctxStats.pct / 5)) + '░'.repeat(20 - Math.floor(ctxStats.pct / 5));
    text += `\n📐 Context: ${ctxBar} ${ctxStats.pct}%\n`;
    text += `   ${(ctxStats.estimatedTokens / 1000).toFixed(1)}k / ${(ctxStats.maxTokens / 1000).toFixed(0)}k tokens (${ctxStats.messages} msgs)\n`;

    const evoState = loadEvolutionState(tenant.userDir);
    const cfg = loadConfig();
    const threshold = cfg?.evolution?.exchanges || 100;
    const evoCount = evoState.exchangesSinceLastEvolution || 0;
    const evoPct = Math.min(100, Math.round((evoCount / threshold) * 100));
    const evoBar = '█'.repeat(Math.floor(evoPct / 5)) + '░'.repeat(20 - Math.floor(evoPct / 5));
    text += `\n🧬 Evolution: ${evoBar} ${evoPct}% (${evoState.evolutionCount || 0} completed)\n`;

    const personalityDir = path.join(tenant.userDir, 'personality');
    const traits = loadTraits(personalityDir);
    text += `\n🎛 Traits\n${formatTraits(traits)}`;

    await ctx.reply(text);
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
      await ctx.reply(`🎛 Traits reset to defaults\n\n${formatTraits(traits)}`);
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
      await ctx.reply(`🎛 Updated ${traitName} → ${value}\n\n${formatTraits(traits)}`);
      return;
    }

    const traits = loadTraits(personalityDir);
    await ctx.reply(`🎛 Personality Traits\n\n${formatTraits(traits)}\n\nAdjust: /traits <name> <0-100>\nReset: /traits reset`);
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
    const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));

    let text = `🧬 Evolution Progress\n\n`;
    text += `${bar} ${pct}%\n`;
    text += `${count}/${threshold} exchanges\n`;
    text += `Evolutions completed: ${state.evolutionCount || 0}\n`;
    if (state.lastEvolution) {
      text += `Last evolution: ${new Date(state.lastEvolution).toLocaleDateString()}`;
    }
    await ctx.reply(text);
  });

  bot.command('tasks', async (ctx) => {
    if (!ctx.from) return;
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

  bot.command('help', async (ctx) => {
    await ctx.reply(`Commands:

/new — Start fresh conversation
/memory search <query> — Search memories
/memory stats — Memory statistics
/recent — Last 10 memories
/today — Today's memories
/forget <id> — Delete a memory
/tasks — Running background tasks
/traits — View/adjust personality traits
/secret — Manage per-user secrets
/evolution — Evolution progress
/status — Bot status and uptime
/backup — Trigger GitHub backup
/clean — Audit workspace
/verbose — Toggle verbose mode on/off
/toolimit — View or set max tool iterations
/help — This message`);
  });

  bot.command('verbose', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    tenant.verbose = !tenant.verbose;
    await ctx.reply(tenant.verbose ? '🔍 Verbose mode ON' : '🔇 Verbose mode OFF');
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

  bot.on('message:text', async (ctx) => {
    if (!ctx.from) return;
    const userMessage = ctx.message.text;
    if (!userMessage || !userMessage.trim()) return;
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || 'User';

    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
      const me = await bot.api.getMe();
      if (!userMessage.includes(`@${me.username}`)) return;
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

    const tenant = await getTenant(userId, config);

    const stopTyping = startTyping(ctx);

    try {
      tenant.messageLog?.log(ctx.chat.id, 'user', userMessage);

      const chatContext = {
        userId,
        userName,
        chatId: ctx.chat.id,
        bg: tenant.bg,
        ctx,
        claude: tenant.claude,
        config,
        verbose: tenant.verbose,
        telegramAsk: (message, options, timeout) => createAsk(ctx, message, options, timeout),
        _notifyFn: (targetUserId, message) => {
          if (!allowedUsers.has(targetUserId)) throw new Error('Cannot notify user outside allowed list');
          return bot.api.sendMessage(targetUserId, message);
        },
      };
      const response = await tenant.claude.chat(userMessage, chatContext);

      tenant.messageLog?.log(ctx.chat.id, 'assistant', response);

      if (tenant.verbose && chatContext.verboseLog?.length) {
        const verboseText = '```\n' + chatContext.verboseLog.join('\n') + '\n```';
        await ctx.reply(verboseText, { parse_mode: 'Markdown' }).catch(() =>
          ctx.reply(verboseText).catch(() => {})
        );
      }

      if (tenant.messageLog?._evolutionReady) {
        tenant.messageLog._evolutionReady = false;
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

      stopTyping();

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
      stopTyping();
      console.error('Message handling error:', e.message);
      if (e.isOAuthExpiry) {
        console.error('[oauth] Full error:', e.stack || e.message);
        await ctx.reply(`OAuth error: ${e.message}\n\nRun \`obol config\` → Anthropic → re-authenticate OAuth.`).catch(() => {});
      } else if (e.status === 401 || e.message?.includes('401')) {
        await ctx.reply('API key invalid or expired. Run `obol config` to update.').catch(() => {});
      } else if (e.status === 429 || e.message?.includes('rate')) {
        await ctx.reply('Rate limited. Wait a moment and try again.').catch(() => {});
      } else {
        await ctx.reply('Something went wrong. Check logs with `obol logs`.').catch(() => {});
      }
    }
  });

  const MAX_MEDIA_SIZE = 50 * 1024 * 1024; // 50MB

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

    const stopTyping = startTyping(ctx);

    try {
      const tenant = await getTenant(userId, config);
      const file = await ctx.getFile();
      const buffer = await media.downloadFile(telegramConfig.token, file.file_path);

      const filename = media.generateFilename(fileInfo, file.file_path);
      const assetsDir = path.join(tenant.userDir, 'assets');
      const savedPath = media.saveFile(buffer, assetsDir, filename);

      const caption = ctx.message.caption || '';

      if (tenant.memory) {
        const memContent = media.buildMemoryContent(fileInfo, filename, savedPath, caption);
        await tenant.memory.add(memContent, {
          category: 'resource',
          importance: 0.6,
          source: 'telegram-media',
          tags: [fileInfo.mediaType],
        }).catch(() => {});
      }

      if (media.isImage(fileInfo)) {
        const imageBlock = media.bufferToImageBlock(buffer, fileInfo.mimeType);
        const prompt = caption || 'The user sent this image. Describe what you see and respond naturally.';
        const mediaChatCtx = {
          userId,
          userName: ctx.from.first_name || 'User',
          chatId: ctx.chat.id,
          bg: tenant.bg,
          ctx,
          claude: tenant.claude,
          config,
          verbose: tenant.verbose,
          images: [imageBlock],
          _notifyFn: (targetUserId, message) => {
            if (!allowedUsers.has(targetUserId)) throw new Error('Cannot notify user outside allowed list');
            return bot.api.sendMessage(targetUserId, message);
          },
        };
        const response = await tenant.claude.chat(prompt, mediaChatCtx);

        tenant.messageLog?.log(ctx.chat.id, 'user', `[${fileInfo.mediaType}] ${caption || filename}`);
        tenant.messageLog?.log(ctx.chat.id, 'assistant', response);

        if (tenant.verbose && mediaChatCtx.verboseLog?.length) {
          const verboseText = '```\n' + mediaChatCtx.verboseLog.join('\n') + '\n```';
          await ctx.reply(verboseText, { parse_mode: 'Markdown' }).catch(() => ctx.reply(verboseText).catch(() => {}));
        }

        stopTyping();
        if (response.length > 4096) {
          for (const chunk of splitMessage(response, 4096)) {
            await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => ctx.reply(chunk));
          }
        } else {
          await ctx.reply(response, { parse_mode: 'Markdown' }).catch(() => ctx.reply(response));
        }
      } else if (caption) {
        const contextMsg = `[User sent a ${fileInfo.mediaType}: ${filename}] ${caption}`;
        const mediaCaptionCtx = {
          userId,
          userName: ctx.from.first_name || 'User',
          chatId: ctx.chat.id,
          bg: tenant.bg,
          ctx,
          claude: tenant.claude,
          config,
          verbose: tenant.verbose,
          _notifyFn: (targetUserId, message) => {
            if (!allowedUsers.has(targetUserId)) throw new Error('Cannot notify user outside allowed list');
            return bot.api.sendMessage(targetUserId, message);
          },
        };
        const response = await tenant.claude.chat(contextMsg, mediaCaptionCtx);

        tenant.messageLog?.log(ctx.chat.id, 'user', contextMsg);
        tenant.messageLog?.log(ctx.chat.id, 'assistant', response);

        if (tenant.verbose && mediaCaptionCtx.verboseLog?.length) {
          const verboseText = '```\n' + mediaCaptionCtx.verboseLog.join('\n') + '\n```';
          await ctx.reply(verboseText, { parse_mode: 'Markdown' }).catch(() => ctx.reply(verboseText).catch(() => {}));
        }

        stopTyping();
        if (response.length > 4096) {
          for (const chunk of splitMessage(response, 4096)) {
            await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => ctx.reply(chunk));
          }
        } else {
          await ctx.reply(response, { parse_mode: 'Markdown' }).catch(() => ctx.reply(response));
        }
      } else {
        stopTyping();
        await ctx.reply(`Got it — saved ${filename}`);
      }
    } catch (e) {
      stopTyping();
      console.error('Media handling error:', e.message);
      await ctx.reply('Failed to process that file. Check logs.').catch(() => {});
    }
  }

  bot.on('message:photo', handleMedia);
  bot.on('message:document', handleMedia);
  bot.on('message:voice', handleMedia);
  bot.on('message:video', handleMedia);
  bot.on('message:audio', handleMedia);
  bot.on('message:sticker', handleMedia);
  bot.on('message:animation', handleMedia);
  bot.on('message:video_note', handleMedia);

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('ask:')) return ctx.answerCallbackQuery();
    const parts = data.split(':');
    const askId = parseInt(parts[1]);
    const optIdx = parseInt(parts[2]);
    const pending = pendingAsks.get(askId);
    if (!pending) return ctx.answerCallbackQuery({ text: 'Expired' });
    const selected = pending.options[optIdx];
    await ctx.answerCallbackQuery({ text: selected });
    clearTimeout(pending.timer);
    pendingAsks.delete(askId);
    ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n✓ _${selected}_`, { parse_mode: 'Markdown' }).catch(() => {});
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
    const filled = Math.round(val / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    return `${name.charAt(0).toUpperCase() + name.slice(1).padEnd(maxLen)} ${bar} ${val}`;
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

module.exports = { createBot };
