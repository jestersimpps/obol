const cron = require('node-cron');
const { createScheduler } = require('./scheduler');

function setupHeartbeat(bot, supabaseConfig) {
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

          if (isRecurring) {
            await scheduler.reschedule(event.id, event.cron_expr, tz, event.run_count, event.max_runs, event.ends_at);
          } else {
            await scheduler.markSent(event.id);
          }
        } catch (e) {
          console.error(`[scheduler] Failed to send event ${event.id}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[scheduler] Failed to check due events:', e.message);
    }
  });

  console.log('  ✅ Heartbeat running (every 1min)');
}

module.exports = { setupHeartbeat };
