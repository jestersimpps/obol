const cron = require('node-cron');
const { createScheduler } = require('./scheduler');
const { getTenant } = require('./tenant');

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

async function runAgenticEvent(bot, config, event) {
  const tenant = await getTenant(event.user_id, config);
  const fakeCtx = makeFakeCtx(bot, event.chat_id);

  const taskId = tenant.bg.spawn(
    tenant.claude,
    event.instructions,
    fakeCtx,
    tenant.memory,
    null,
    {},
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
