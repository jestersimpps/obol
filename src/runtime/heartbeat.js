const cron = require('node-cron');
const { createScheduler } = require('./scheduler');
const { getTenant } = require('../tenant');
const { shouldEvolveNow, evolve } = require('../evolve');
const { ensureUserDir, getUserTimezone } = require('../config');
const { runAnalysis } = require('../analysis');
const { runProactiveNews } = require('../news');
const { createSelfMemory } = require('../memory/self');
const { createAnthropicClient, ensureFreshToken } = require('../claude/client');
const { markdownToTelegramHtml } = require('../telegram/utils');


const ANALYSIS_HOURS = new Set([4, 7, 10, 13, 16, 19, 22]);
const NEWS_HOURS = new Set([8, 18]);

const _evolutionRunning = new Set();
const _newsRunning = new Set();
const _inflight = new Set();
const _analysisRunning = new Set();

async function getFreshClient(config) {
  const ac = config.anthropic;
  if (ac.oauth?.accessToken) await ensureFreshToken(ac);
  return ac._oauthFailed
    ? createAnthropicClient(ac, { useOAuth: false })
    : createAnthropicClient(ac);
}

function getLocalHour(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return {
    hour: parseInt(parts.find(p => p.type === 'hour').value),
    minute: parseInt(parts.find(p => p.type === 'minute').value),
  };
}

async function runEvolutionForUser(bot, config, userId) {
  if (_evolutionRunning.has(userId)) return;

  const timezone = getUserTimezone(config, userId);
  const userDir = ensureUserDir(userId);

  if (!shouldEvolveNow(userDir, timezone)) return;

  _evolutionRunning.add(userId);
  console.log(`[evolution] Starting nightly evolution for user ${userId}`);

  try {
    const tenant = await getTenant(userId, config);
    const client = await getFreshClient(config);
    const selfMemory = config.supabase ? await createSelfMemory(config.supabase, 0).catch(() => null) : null;
    const result = await evolve(client, tenant.messageLog, tenant.memory, tenant.userDir, config.supabase, selfMemory);
    tenant.claude.reloadPersonality?.();

    let msg = `🪙 Evolution #${result.evolutionNumber} complete.`;
    if (result.scriptsFixed) msg += '\n🔧 Fixed a test regression automatically.';
    else if (result.scriptsRolledBack) msg += '\n⚠️ Rolled back a script refactor — tests couldn\'t be fixed.';

    if (result.upgrades?.length > 0) {
      msg += '\n\n🆕 <b>New capabilities:</b>';
      for (const u of result.upgrades) {
        msg += `\n• <b>${u.name}</b> — ${u.description}`;
        if (u.command) msg += ` → <code>${u.command}</code>`;
      }
    }

    if (result.deployedApps?.length > 0) {
      msg += '\n\n🚀 <b>Deployed:</b>';
      for (const app of result.deployedApps) {
        msg += app.url
          ? `\n• ${app.name} → ${app.url}`
          : `\n• ${app.name} — deploy failed: ${(app.error || '').substring(0, 100)}`;
      }
    }

    if (result.changelog) msg += `\n\n<i>${result.changelog}</i>`;

    await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' }).catch(() => {});
    console.log(`[evolution] Completed evolution #${result.evolutionNumber} for user ${userId}`);
  } catch (e) {
    console.error(`[evolution] Failed for user ${userId}:`, e.message);
  } finally {
    _evolutionRunning.delete(userId);
  }
}

async function runAnalysisForUser(bot, config, userId) {
  if (_analysisRunning.has(userId)) return;
  _analysisRunning.add(userId);
  const timezone = getUserTimezone(config, userId);
  try {
    const tenant = await getTenant(userId, config);
    if (!tenant.messageLog || !tenant.scheduler || !tenant.patterns) return;
    const client = await getFreshClient(config);
    await runAnalysis(client, tenant.messageLog, tenant.scheduler, tenant.patterns, tenant.memory, userId, userId, timezone);
  } catch (e) {
    console.error(`[analysis] Failed for user ${userId}:`, e.message);
  } finally {
    _analysisRunning.delete(userId);
  }
}

async function runNewsForUser(bot, config, userId) {
  if (_newsRunning.has(userId)) return;

  const tenant = await getTenant(userId, config);
  const pref = tenant.toolPrefs?.get('proactive_news');
  if (!pref?.enabled) return;

  const topics = pref.config?.topics || [];
  if (topics.length === 0) return;

  _newsRunning.add(userId);
  console.log(`[news] Starting proactive news for user ${userId}, topics: ${topics.join(', ')}`);

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 5 });
    const timezone = getUserTimezone(config, userId);

    const selfMemory = config.supabase ? await createSelfMemory(config.supabase, 0).catch(() => null) : null;
    const messages = await runProactiveNews(client, topics, tenant.memory, tenant.personality, timezone, selfMemory);

    for (let i = 0; i < messages.length; i++) {
      if (i > 0) {
        const delay = 30_000 + Math.random() * 120_000;
        await new Promise(r => setTimeout(r, delay));
      }
      await bot.api.sendMessage(userId, messages[i]).catch(() =>
        bot.api.sendMessage(userId, messages[i], { parse_mode: undefined }).catch(() => {})
      );
    }

    console.log(`[news] Sent ${messages.length} messages to user ${userId}`);
  } catch (e) {
    console.error(`[news] Failed for user ${userId}:`, e.message);
  } finally {
    _newsRunning.delete(userId);
  }
}

const MAX_ATTEMPTS = 3;
const STALE_MS = 2 * 60 * 60 * 1000;

async function processEvent(bot, config, scheduler, event) {
  const tz = event.timezone || 'UTC';
  const age = Date.now() - new Date(event.due_at).getTime();

  if (age > STALE_MS) {
    console.warn(`[scheduler] Stale event ${event.id} "${event.title}" (due ${event.due_at})`);
    if (event.cron_expr) {
      await scheduler.reschedule(event.id, event.cron_expr, tz, event.run_count, event.max_runs, event.ends_at);
    } else {
      await scheduler.markFailed(event.id, 'Stale — exceeded 2h window');
    }
    return;
  }

  const attempts = (event.attempts || 0) + 1;
  await scheduler.patch(event.id, { attempts });

  try {
    if (event.instructions) {
      await runAgenticEvent(bot, config, event);
    } else {
      await sendReminderMessage(bot, event);
    }

    if (event.cron_expr) {
      await scheduler.patch(event.id, { last_error: null });
      await scheduler.reschedule(event.id, event.cron_expr, tz, event.run_count, event.max_runs, event.ends_at);
    } else {
      await scheduler.markSent(event.id);
    }
  } catch (e) {
    const errMsg = (e.message || '').substring(0, 500);
    console.error(`[scheduler] Event ${event.id} attempt ${attempts} failed:`, errMsg);
    await scheduler.patch(event.id, { last_error: errMsg });

    if (attempts >= MAX_ATTEMPTS) {
      if (event.cron_expr) {
        await scheduler.reschedule(event.id, event.cron_expr, tz, event.run_count, event.max_runs, event.ends_at);
      } else {
        await scheduler.markFailed(event.id, errMsg);
      }
      await bot.api.sendMessage(event.chat_id,
        `⚠️ Scheduled event "${event.title}" failed: ${errMsg.substring(0, 200)}`
      ).catch(() => {});
    }
  }
}

function setupHeartbeat(bot, config) {
  const supabaseConfig = config?.supabase;
  let scheduler = null;
  if (supabaseConfig?.url && supabaseConfig?.serviceKey) {
    scheduler = createScheduler(supabaseConfig);
  }

  let tickCount = 0;

  cron.schedule('* * * * *', async () => {
    tickCount++;
    if (tickCount % 30 === 0) {
      console.log(`[${new Date().toISOString()}] Heartbeat tick`);
    }

    if (!scheduler || !bot) return;

    try {
      const dueEvents = await scheduler.getDue(MAX_ATTEMPTS);
      if (dueEvents.length > 0) {
        console.log(`[scheduler] Processing ${dueEvents.length} due event(s)`);
      }
      for (const event of dueEvents) {
        if (_inflight.has(event.id)) continue;

        _inflight.add(event.id);
        processEvent(bot, config, scheduler, event)
          .catch(e => console.error(`[scheduler] Unhandled error for event ${event.id}:`, e.message))
          .finally(() => _inflight.delete(event.id));
      }
    } catch (e) {
      console.error('[scheduler] Failed to check due events:', e.message);
    }
  });

  const allowedUsers = config?.telegram?.allowedUsers || [];
  if (allowedUsers.length > 0) {
    cron.schedule('* * * * *', async () => {
      for (const userId of allowedUsers) {
        const tz = getUserTimezone(config, userId);
        const { hour, minute } = getLocalHour(tz);
        if (hour !== 3 || minute !== 0) continue;
        runEvolutionForUser(bot, config, userId).catch(e =>
          console.error(`[evolution] Unhandled error for user ${userId}:`, e.message)
        );
      }
    });
    console.log('  ✅ Evolution cron running (daily 3am per-user timezone)');

    cron.schedule('* * * * *', async () => {
      for (const userId of allowedUsers) {
        const tz = getUserTimezone(config, userId);
        const { hour, minute } = getLocalHour(tz);
        if (!ANALYSIS_HOURS.has(hour) || minute !== 0) continue;
        runAnalysisForUser(bot, config, userId).catch(e =>
          console.error(`[analysis] Unhandled error for user ${userId}:`, e.message)
        );
      }
    });
    console.log('  ✅ Analysis cron running (every 3h per-user timezone)');

    cron.schedule('* * * * *', async () => {
      for (const userId of allowedUsers) {
        const tz = getUserTimezone(config, userId);
        const { hour, minute } = getLocalHour(tz);
        if (!NEWS_HOURS.has(hour) || minute !== 0) continue;
        runNewsForUser(bot, config, userId).catch(e =>
          console.error(`[news] Unhandled error for user ${userId}:`, e.message)
        );
      }
    });
    console.log('  ✅ News cron running (8am + 6pm per-user timezone)');
  }

  console.log('  ✅ Heartbeat running (every 1min)');
}

async function sendReminderMessage(bot, event) {
  const tz = event.timezone || 'UTC';
  const dueLocal = new Date(event.due_at).toLocaleString('en-US', { timeZone: tz });
  const isRecurring = !!event.cron_expr;
  const prefix = isRecurring ? '🔄 *Recurring Reminder:*' : '⏰ *Reminder:*';
  let text = `${prefix} ${event.title}`;
  if (event.description) text += `\n${event.description}`;
  text += `\n_${dueLocal} (${tz})_`;

  await bot.api.sendMessage(event.chat_id, text, { parse_mode: 'Markdown' }).catch(() =>
    bot.api.sendMessage(event.chat_id, `${isRecurring ? '🔄 Recurring Reminder' : '⏰ Reminder'}: ${event.title}${event.description ? '\n' + event.description : ''}`)
  );
}

async function buildProactiveContext(tenant, timezone, query) {
  const parts = [];

  const localTime = new Date().toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  parts.push(`Local time: ${localTime} (${timezone})`);

  if (tenant.patterns) {
    const formatted = await tenant.patterns.format().catch(() => null);
    if (formatted) parts.push(`\nUser patterns:\n${formatted}`);
  }

  if (tenant.memory) {
    const memories = query
      ? await tenant.memory.search(query, { limit: 5 }).catch(() => [])
      : await tenant.memory.recent({ limit: 5 }).catch(() => []);
    if (memories.length > 0) {
      parts.push(`\nRecent memory:\n${memories.map(m => `- ${m.content}`).join('\n')}`);
    }
  }

  return parts.join('\n');
}

async function runAgenticEvent(bot, config, event) {
  const tenant = await getTenant(event.user_id, config);
  const timezone = event.timezone || getUserTimezone(config, event.user_id);

  const query = event.description || event.instructions;
  const proactiveContext = await buildProactiveContext(tenant, timezone, query).catch(() => '');

  const contextPrefix = proactiveContext
    ? `[Scheduled task context — ${timezone}]\n${proactiveContext}\n\n`
    : '';
  const prompt = `${contextPrefix}Scheduled task "${event.title}":\n${event.instructions}`;

  const chatId = `scheduled-${event.id}-${Date.now()}`;
  const { text } = await tenant.claude.chat(prompt, {
    chatId,
    userName: 'ScheduledTask',
    userId: event.user_id,
    userDir: tenant.userDir,
    toolPrefs: tenant.toolPrefs,
    config,
    scheduler: tenant.scheduler,
    messageLog: tenant.messageLog,
  });

  tenant.claude.clearHistory(chatId);

  if (!text?.trim()) throw new Error('Empty response from model');

  await sendScheduledMessage(bot, event.chat_id, text);

  tenant.claude.injectHistory(event.chat_id, 'assistant', text);
  if (tenant.messageLog) {
    await tenant.messageLog.log(event.chat_id, 'assistant', text, { model: 'claude-sonnet-4-6' }).catch(() => {});
  }
}

async function sendScheduledMessage(bot, chatId, text) {
  const html = markdownToTelegramHtml(text);
  if (html.length <= 4096) {
    await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' }).catch(() =>
      bot.api.sendMessage(chatId, text)
    );
    return;
  }

  let remaining = html;
  while (remaining.length > 0) {
    if (remaining.length <= 4096) {
      await bot.api.sendMessage(chatId, remaining, { parse_mode: 'HTML' }).catch(() =>
        bot.api.sendMessage(chatId, remaining)
      );
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', 4096);
    if (splitAt === -1 || splitAt < 2000) splitAt = 4096;
    const chunk = remaining.substring(0, splitAt);
    await bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' }).catch(() =>
      bot.api.sendMessage(chatId, chunk)
    );
    remaining = remaining.substring(splitAt).trimStart();
  }
}

module.exports = { setupHeartbeat };
