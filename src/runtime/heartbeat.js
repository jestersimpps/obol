const cron = require('node-cron');
const { createScheduler } = require('./scheduler');
const { getTenant } = require('../tenant');
const { shouldEvolveNow, evolve } = require('../evolve');
const { ensureUserDir, getUserTimezone } = require('../config');
const { runAnalysis } = require('../analysis');
const { runCuriosity } = require('../curiosity');
const { runCuriosityDispatch } = require('../curiosity/dispatch');
const { runCuriosityHumor } = require('../curiosity/humor');
const { runProactiveNews } = require('../curiosity/news');
const { createSelfMemory } = require('../memory/self');


const ANALYSIS_HOURS = new Set([4, 7, 10, 13, 16, 19, 22]);
const CURIOSITY_HOURS = new Set([1, 13]);
const NEWS_HOURS = new Set([8, 18]);

const _evolutionRunning = new Set();
const _newsRunning = new Set();
let _curiosityRunning = false;

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
    const selfMemory = config.supabase ? await createSelfMemory(config.supabase, 0).catch(() => null) : null;
    const result = await evolve(tenant.claude.client, tenant.messageLog, tenant.memory, tenant.userDir, config.supabase, selfMemory);
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

async function runCuriosityOnce(config, allowedUsers) {
  if (!config.supabase) return;
  if (_curiosityRunning) {
    console.log('[curiosity] Skipping — previous cycle still running');
    return;
  }

  const enabledUsers = [];
  for (const userId of allowedUsers) {
    const tenant = await getTenant(userId, config);
    const pref = tenant.toolPrefs?.get('curiosity');
    const enabled = pref ? pref.enabled : true;
    if (enabled) enabledUsers.push(userId);
  }

  if (!enabledUsers.length) {
    console.log('[curiosity] Skipping — no users have curiosity enabled');
    return;
  }

  _curiosityRunning = true;
  try {
    const selfMemory = await createSelfMemory(config.supabase, 0);
    const firstTenant = await getTenant(enabledUsers[0], config);
    const client = firstTenant.claude.client;

    const contexts = await Promise.all(enabledUsers.map(async (userId) => {
      try {
        const tenant = await getTenant(userId, config);
        const parts = [];
        if (tenant.personality?.user) parts.push(tenant.personality.user);
        if (tenant.patterns) {
          const fmt = await tenant.patterns.format().catch(() => null);
          if (fmt) parts.push(fmt);
        }
        if (tenant.memory) {
          const recent = await tenant.memory.recent({ limit: 3 }).catch(() => []);
          if (recent.length) parts.push(recent.map(m => `- ${m.content}`).join('\n'));
        }
        if (tenant.scheduler) {
          const events = await tenant.scheduler.list({ status: 'pending', limit: 3 }).catch(() => []);
          if (events.length) parts.push(events.map(e => `- ${e.title}`).join('\n'));
        }
        return parts.join('\n');
      } catch {
        return null;
      }
    }));

    const peopleContext = contexts.filter(Boolean).join('\n\n---\n\n');
    const firstUserDir = firstTenant.userDir;
    await runCuriosity(client, selfMemory, 0, { peopleContext, userDir: firstUserDir });

    const userDispatchData = await Promise.all(enabledUsers.map(async (userId) => {
      try {
        const tenant = await getTenant(userId, config);
        const patterns = tenant.patterns ? await tenant.patterns.format().catch(() => null) : null;
        const events = tenant.scheduler
          ? await tenant.scheduler.list({ status: 'pending', limit: 5 }).catch(() => [])
          : [];
        const userProfile = tenant.personality?.user || null;
        return { userId, chatId: userId, timezone: getUserTimezone(config, userId), patterns, events, scheduler: tenant.scheduler, userProfile };
      } catch { return null; }
    }));
    await runCuriosityDispatch(client, selfMemory, userDispatchData.filter(Boolean));
    await runCuriosityHumor(client, selfMemory, userDispatchData.filter(Boolean));
  } catch (e) {
    console.error('[curiosity] Failed:', e.message);
  } finally {
    _curiosityRunning = false;
  }
}

async function runAnalysisForUser(bot, config, userId) {
  const timezone = getUserTimezone(config, userId);
  try {
    const tenant = await getTenant(userId, config);
    if (!tenant.messageLog || !tenant.scheduler || !tenant.patterns) return;
    await runAnalysis(tenant.claude.client, tenant.messageLog, tenant.scheduler, tenant.patterns, tenant.memory, userId, userId, timezone);
  } catch (e) {
    console.error(`[analysis] Failed for user ${userId}:`, e.message);
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
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
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

function makeFakeCtx(bot, chatId) {
  return {
    chat: { id: chatId },
    reply: (text, opts) => bot.api.sendMessage(chatId, text, opts),
    api: bot.api,
  };
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
      const dueEvents = await scheduler.getDue();
      for (const event of dueEvents) {
        try {
          if (event.instructions) {
            await runAgenticEvent(bot, config, event);
          } else {
            await sendReminderMessage(bot, event);
          }

          const tz = event.timezone || 'UTC';
          if (event.cron_expr) {
            await scheduler.reschedule(event.id, event.cron_expr, tz, event.run_count, event.max_runs, event.ends_at);
          } else {
            await scheduler.markSent(event.id);
          }
        } catch (e) {
          console.error(`[scheduler] Failed to process event ${event.id}:`, e.message);
        }
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
      const tz = config.timezone || 'UTC';
      const { hour, minute } = getLocalHour(tz);
      if (!CURIOSITY_HOURS.has(hour) || minute !== 0) return;

      runCuriosityOnce(config, allowedUsers).catch(e =>
        console.error('[curiosity] Unhandled error:', e.message)
      );
    });
    console.log(`  ✅ Curiosity cron running (every 6h ${config.timezone || 'UTC'})`);


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
  const context = await buildProactiveContext(tenant, timezone, query).catch(() => '');
  const instructions = context
    ? `[Context]\n${context}\n\n---\n\n${event.instructions}`
    : event.instructions;

  const fakeCtx = makeFakeCtx(bot, event.chat_id);

  const taskId = tenant.bg.spawn(
    tenant.claude,
    instructions,
    fakeCtx,
    tenant.memory,
    null,
    { silent: true },
    {
      userId: event.user_id,
      chatId: event.chat_id,
      config,
      scheduler: tenant.scheduler,
      toolPrefs: tenant.toolPrefs,
    }
  );

  if (taskId === null) {
    await bot.api.sendMessage(event.chat_id, `⚠️ Could not run "${event.title}" — too many background tasks already running.`).catch(() => {});
  }
}

module.exports = { setupHeartbeat };
