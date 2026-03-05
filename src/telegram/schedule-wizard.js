const { InlineKeyboard } = require('grammy');
const { CronExpressionParser } = require('cron-parser');
const { sendHtml, editHtml } = require('./utils');
const { toUTC } = require('../claude/utils');

const TITLE_TTL_MS = 120_000;
const TIME_TTL_MS = 120_000;
const CRON_TTL_MS = 120_000;
const DESC_TTL_MS = 120_000;
const INSTR_TTL_MS = 180_000;

/** @type {Map<number, { chatId: number, messageId: number }[]>} */
const schedFlowMessages = new Map();

/** @type {Map<number, { step: string, isRecurring: boolean, isAgentic: boolean, title?: string, dueAt?: string, timezone?: string, cronExpr?: string, maxRuns?: number, description?: string, instructions?: string, editMsgId?: number }>} */
const schedDrafts = new Map();

/** @type {Map<number, { timer: ReturnType<typeof setTimeout>, field: string }>} */
const pendingSchedInput = new Map();

function trackMsg(userId, chatId, messageId) {
  if (!schedFlowMessages.has(userId)) schedFlowMessages.set(userId, []);
  schedFlowMessages.get(userId).push({ chatId, messageId });
}

async function clearSchedFlow(userId, bot) {
  const msgs = schedFlowMessages.get(userId);
  if (!msgs) return;
  schedFlowMessages.delete(userId);
  cancelPending(userId);
  schedDrafts.delete(userId);
  for (const { chatId, messageId } of msgs) {
    bot.api.deleteMessage(chatId, messageId).catch(() => {});
  }
}

function cancelPending(userId) {
  const pending = pendingSchedInput.get(userId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSchedInput.delete(userId);
  }
}

function setPendingInput(userId, field, ttlMs) {
  cancelPending(userId);
  const timer = setTimeout(() => pendingSchedInput.delete(userId), ttlMs);
  pendingSchedInput.set(userId, { timer, field });
}

function isPendingSchedInput(userId) {
  return pendingSchedInput.has(userId);
}

async function startWizard(ctx, config) {
  const userId = ctx.from.id;
  await clearSchedFlow(userId, ctx.api);

  schedDrafts.set(userId, { step: 'type', isRecurring: false, isAgentic: false });

  const kb = new InlineKeyboard()
    .text('One-time reminder', 'sched:type:reminder').row()
    .text('Recurring reminder', 'sched:type:recurring').row()
    .text('Agentic task', 'sched:type:agentic').row()
    .text('Recurring agentic task', 'sched:type:agentic-rec');

  const msg = await ctx.reply('What would you like to schedule?', { reply_markup: kb });
  trackMsg(userId, msg.chat.id, msg.message_id);
}

async function stepTitle(ctx, userId) {
  const draft = schedDrafts.get(userId);
  if (!draft) return;
  draft.step = 'title';

  setPendingInput(userId, 'title', TITLE_TTL_MS);
  const msg = await ctx.reply('What\'s the title for this event?');
  trackMsg(userId, msg.chat.id, msg.message_id);
}

async function stepTime(ctx, userId) {
  const draft = schedDrafts.get(userId);
  if (!draft) return;
  draft.step = 'time';

  const { getTenant } = require('../tenant');
  let tz = 'UTC';
  try {
    const tenant = await getTenant(userId, ctx._config || {});
    if (tenant.memory) {
      const hits = await tenant.memory.search('timezone', { limit: 1, threshold: 0.3 });
      for (const h of hits) {
        const match = h.content.match(/(?:timezone|time zone)[:\s]+([A-Za-z_/]+)/i);
        if (match) { tz = match[1]; break; }
      }
    }
  } catch {}

  draft.timezone = tz;
  setPendingInput(userId, 'time', TIME_TTL_MS);

  const kb = new InlineKeyboard()
    .text(`Use ${tz}`, 'sched:tz:confirm')
    .text('Change timezone', 'sched:tz:change');

  const msg = await sendHtml(ctx,
    `When should it ${draft.isRecurring ? 'first fire' : 'fire'}?\n\n` +
    `Examples: \`2026-03-10 14:00\`, \`tomorrow at 9am\`\n` +
    `Timezone: ${tz}`,
    { reply_markup: kb }
  );
  trackMsg(userId, msg.chat.id, msg.message_id);
}

async function stepCron(ctx, userId) {
  const draft = schedDrafts.get(userId);
  if (!draft || !draft.isRecurring) { stepDescription(ctx, userId); return; }
  draft.step = 'cron';

  const due = new Date(draft.dueAt);
  const h = due.getUTCHours();
  const m = due.getUTCMinutes();

  const kb = new InlineKeyboard()
    .text('Every hour', `sched:cron:hourly`)
    .text('Every day', `sched:cron:daily`).row()
    .text('Every weekday', `sched:cron:weekday`)
    .text('Every week', `sched:cron:weekly`).row()
    .text('Every month', `sched:cron:monthly`)
    .text('Custom cron', `sched:cron:custom`);

  const msg = await ctx.reply('How often should it repeat?', { reply_markup: kb });
  trackMsg(userId, msg.chat.id, msg.message_id);
}

async function stepLimits(ctx, userId) {
  const draft = schedDrafts.get(userId);
  if (!draft || !draft.isRecurring) { stepDescription(ctx, userId); return; }
  draft.step = 'limits';

  const kb = new InlineKeyboard()
    .text('Max 10 runs', 'sched:maxruns:10')
    .text('Max 50 runs', 'sched:maxruns:50').row()
    .text('No limit', 'sched:maxruns:0')
    .text('Skip', 'sched:limits:skip');

  const msg = await ctx.reply('Set limits? (optional)', { reply_markup: kb });
  trackMsg(userId, msg.chat.id, msg.message_id);
}

async function stepDescription(ctx, userId) {
  const draft = schedDrafts.get(userId);
  if (!draft) return;
  draft.step = 'description';

  setPendingInput(userId, 'description', DESC_TTL_MS);
  const kb = new InlineKeyboard().text('Skip', 'sched:desc:skip');
  const msg = await ctx.reply('Add a description? (optional)\nType one, or tap Skip.', { reply_markup: kb });
  trackMsg(userId, msg.chat.id, msg.message_id);
}

async function stepInstructions(ctx, userId) {
  const draft = schedDrafts.get(userId);
  if (!draft || !draft.isAgentic) { stepReview(ctx, userId); return; }
  draft.step = 'instructions';

  setPendingInput(userId, 'instructions', INSTR_TTL_MS);
  const msg = await sendHtml(ctx,
    'What should the bot do when this event fires?\n\n' +
    'Be specific — this runs as an LLM task. Examples:\n' +
    '• "Check my email and summarize unread messages"\n' +
    '• "Fetch the weather for Brussels and send a morning briefing"\n' +
    '• "Check Bitcoin price and alert me if above $100k"'
  );
  trackMsg(userId, msg.chat.id, msg.message_id);
}

async function stepReview(ctx, userId) {
  const draft = schedDrafts.get(userId);
  if (!draft) return;
  draft.step = 'review';
  cancelPending(userId);

  const typeLabel = draft.isRecurring && draft.isAgentic ? 'Recurring agentic task'
    : draft.isRecurring ? 'Recurring reminder'
    : draft.isAgentic ? 'Agentic task'
    : 'One-time reminder';

  const tz = draft.timezone || 'UTC';
  const dueLocal = new Date(draft.dueAt).toLocaleString('en-US', {
    timeZone: tz, dateStyle: 'medium', timeStyle: 'short',
  });

  let text = `<b>Title:</b> ${escHtml(draft.title)}\n` +
    `<b>Type:</b> ${typeLabel}\n` +
    `<b>Fire:</b> ${dueLocal} (${tz})`;

  if (draft.cronExpr) {
    text += `\n<b>Repeat:</b> ${escHtml(draft.cronExpr)}`;
    if (draft.maxRuns) text += ` (max ${draft.maxRuns} runs)`;
  }
  if (draft.description) text += `\n<b>Description:</b> ${escHtml(draft.description)}`;
  if (draft.instructions) text += `\n<b>Instructions:</b> ${escHtml(draft.instructions.substring(0, 200))}${draft.instructions.length > 200 ? '...' : ''}`;

  const kb = new InlineKeyboard()
    .text('Confirm', 'sched:confirm')
    .text('Cancel', 'sched:cancel').row()
    .text('Edit title', 'sched:edit:title')
    .text('Edit time', 'sched:edit:time');

  if (draft.isRecurring) kb.text('Edit schedule', 'sched:edit:cron');
  kb.row();
  if (draft.description) kb.text('Edit description', 'sched:edit:desc');
  if (draft.isAgentic) kb.text('Edit instructions', 'sched:edit:instr');

  const msg = await ctx.api.sendMessage(ctx.chat?.id || ctx.from.id, text, {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
  trackMsg(userId, msg.chat.id, msg.message_id);
}

async function confirmAndCreate(ctx, userId, { getTenant, config, bot }) {
  const draft = schedDrafts.get(userId);
  if (!draft) return;

  const tenant = await getTenant(userId, config);
  if (!tenant.scheduler) {
    await ctx.api.sendMessage(ctx.chat?.id || userId, 'Scheduler not configured.');
    await clearSchedFlow(userId, bot);
    return;
  }

  try {
    await tenant.scheduler.add(
      ctx.chat?.id || userId,
      draft.title,
      draft.dueAt,
      draft.timezone || 'UTC',
      draft.description || null,
      draft.cronExpr || null,
      draft.maxRuns || null,
      null,
      draft.instructions || null
    );
    await ctx.api.sendMessage(ctx.chat?.id || userId, `Scheduled: ${draft.title}`);
  } catch (e) {
    await ctx.api.sendMessage(ctx.chat?.id || userId, `Failed to create event: ${e.message}`);
  }

  await clearSchedFlow(userId, bot);
}

function parseDateTime(input, timezone) {
  const now = new Date();
  const lower = input.trim().toLowerCase();

  const relMatch = lower.match(/^(tomorrow|today)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (relMatch) {
    const [, day, hr, min, ampm] = relMatch;
    let h = parseInt(hr);
    if (ampm?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (ampm?.toLowerCase() === 'am' && h === 12) h = 0;
    const m = min ? parseInt(min) : 0;

    const tzNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const date = new Date(tzNow);
    if (day === 'tomorrow') date.setDate(date.getDate() + 1);
    date.setHours(h, m, 0, 0);

    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    return toUTC(iso, timezone);
  }

  const inMatch = lower.match(/^in\s+(\d+)\s*(min(?:ute)?s?|hours?|h|m)$/i);
  if (inMatch) {
    const [, amt, unit] = inMatch;
    const ms = unit.startsWith('h') ? parseInt(amt) * 3600000 : parseInt(amt) * 60000;
    return new Date(now.getTime() + ms).toISOString();
  }

  const dtMatch = input.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (dtMatch) {
    const [, y, mo, d, h, mi] = dtMatch;
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:00`;
    return toUTC(iso, timezone);
  }

  const dateOnly = input.match(/(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T09:00:00`;
    return toUTC(iso, timezone);
  }

  return null;
}

function buildCronFromPreset(preset, dueAtUtc) {
  const due = new Date(dueAtUtc);
  const h = due.getUTCHours();
  const m = due.getUTCMinutes();
  const dow = due.getUTCDay();
  const dom = due.getUTCDate();

  switch (preset) {
    case 'hourly': return `${m} * * * *`;
    case 'daily': return `${m} ${h} * * *`;
    case 'weekday': return `${m} ${h} * * 1-5`;
    case 'weekly': return `${m} ${h} * * ${dow}`;
    case 'monthly': return `${m} ${h} ${dom} * *`;
    default: return null;
  }
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handleSchedCallback(ctx, data, answer, { getTenant, config, bot }) {
  if (!ctx.from) return answer();
  const userId = ctx.from.id;
  const parts = data.split(':');
  const action = parts[1];
  const value = parts.slice(2).join(':');

  if (action === 'type') {
    const draft = schedDrafts.get(userId);
    if (!draft) return answer({ text: 'Session expired' });

    draft.isRecurring = value === 'recurring' || value === 'agentic-rec';
    draft.isAgentic = value === 'agentic' || value === 'agentic-rec';
    await answer();
    ctx._config = config;
    await stepTitle(ctx, userId);
    return;
  }

  if (action === 'tz') {
    const draft = schedDrafts.get(userId);
    if (!draft) return answer({ text: 'Session expired' });

    if (value === 'confirm') {
      await answer({ text: `Using ${draft.timezone} — now type the date/time` });
      return;
    }
    if (value === 'change') {
      await answer();
      cancelPending(userId);
      setPendingInput(userId, 'timezone', TIME_TTL_MS);
      const msg = await ctx.api.sendMessage(ctx.chat?.id || userId,
        'Enter your timezone (e.g. Europe/Brussels, America/New_York, Asia/Tokyo):');
      trackMsg(userId, msg.chat.id, msg.message_id);
      return;
    }
    return answer();
  }

  if (action === 'cron') {
    const draft = schedDrafts.get(userId);
    if (!draft) return answer({ text: 'Session expired' });

    if (value === 'custom') {
      await answer();
      setPendingInput(userId, 'cron', CRON_TTL_MS);
      const msg = await sendHtml(ctx,
        'Enter a cron expression (5 fields):\n\n' +
        'Examples:\n' +
        '`0 9 * * *` — daily at 9am\n' +
        '`*/30 * * * *` — every 30 minutes\n' +
        '`0 9 * * 1-5` — weekdays at 9am',
      );
      trackMsg(userId, msg.chat.id, msg.message_id);
      return;
    }

    const cron = buildCronFromPreset(value, draft.dueAt);
    if (cron) {
      draft.cronExpr = cron;
      await answer({ text: `Schedule: ${cron}` });
      await stepLimits(ctx, userId);
    } else {
      await answer({ text: 'Unknown preset' });
    }
    return;
  }

  if (action === 'maxruns') {
    const draft = schedDrafts.get(userId);
    if (!draft) return answer({ text: 'Session expired' });
    draft.maxRuns = parseInt(value) || null;
    await answer();
    await stepDescription(ctx, userId);
    return;
  }

  if (action === 'limits' && value === 'skip') {
    await answer();
    await stepDescription(ctx, userId);
    return;
  }

  if (action === 'desc' && value === 'skip') {
    const draft = schedDrafts.get(userId);
    if (!draft) return answer({ text: 'Session expired' });
    cancelPending(userId);
    await answer();
    if (draft.isAgentic) {
      await stepInstructions(ctx, userId);
    } else {
      await stepReview(ctx, userId);
    }
    return;
  }

  if (action === 'confirm') {
    await answer({ text: 'Creating event...' });
    await confirmAndCreate(ctx, userId, { getTenant, config, bot });
    return;
  }

  if (action === 'cancel') {
    await answer({ text: 'Cancelled' });
    await clearSchedFlow(userId, bot);
    return;
  }

  if (action === 'edit') {
    const draft = schedDrafts.get(userId);
    if (!draft) return answer({ text: 'Session expired' });
    await answer();

    switch (value) {
      case 'title': await stepTitle(ctx, userId); break;
      case 'time': ctx._config = config; await stepTime(ctx, userId); break;
      case 'cron': await stepCron(ctx, userId); break;
      case 'desc': await stepDescription(ctx, userId); break;
      case 'instr': await stepInstructions(ctx, userId); break;
      default: break;
    }
    return;
  }

  return answer();
}

async function handleSchedText(ctx, text, { getTenant, config, bot }) {
  const userId = ctx.from.id;
  const pending = pendingSchedInput.get(userId);
  if (!pending) return;
  const { field } = pending;
  cancelPending(userId);

  const draft = schedDrafts.get(userId);
  if (!draft) return;

  trackMsg(userId, ctx.chat.id, ctx.message.message_id);

  if (field === 'title') {
    draft.title = text.substring(0, 200);
    ctx._config = config;
    await stepTime(ctx, userId);
    return;
  }

  if (field === 'timezone') {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: text.trim() });
      draft.timezone = text.trim();
      const msg = await ctx.reply(`Timezone set to ${draft.timezone}. Now enter the date/time.`);
      trackMsg(userId, msg.chat.id, msg.message_id);
      setPendingInput(userId, 'time', TIME_TTL_MS);
    } catch {
      const msg = await ctx.reply('Invalid timezone. Try again (e.g. Europe/Brussels, America/New_York):');
      trackMsg(userId, msg.chat.id, msg.message_id);
      setPendingInput(userId, 'timezone', TIME_TTL_MS);
    }
    return;
  }

  if (field === 'time') {
    const tz = draft.timezone || 'UTC';
    const parsed = parseDateTime(text, tz);
    if (!parsed) {
      const msg = await sendHtml(ctx, 'Could not parse that date/time. Try:\n`2026-03-10 14:00` or `tomorrow at 9am`');
      trackMsg(userId, msg.chat.id, msg.message_id);
      setPendingInput(userId, 'time', TIME_TTL_MS);
      return;
    }

    const parsedDate = new Date(parsed);
    if (parsedDate <= new Date()) {
      const msg = await ctx.reply('That time is in the past. Enter a future date/time:');
      trackMsg(userId, msg.chat.id, msg.message_id);
      setPendingInput(userId, 'time', TIME_TTL_MS);
      return;
    }

    draft.dueAt = parsed;
    if (draft.isRecurring) {
      await stepCron(ctx, userId);
    } else {
      await stepDescription(ctx, userId);
    }
    return;
  }

  if (field === 'cron') {
    try {
      CronExpressionParser.parse(text.trim());
      draft.cronExpr = text.trim();
      await stepLimits(ctx, userId);
    } catch {
      const msg = await sendHtml(ctx, 'Invalid cron expression. Try again:\n`0 9 * * *` — daily at 9am');
      trackMsg(userId, msg.chat.id, msg.message_id);
      setPendingInput(userId, 'cron', CRON_TTL_MS);
    }
    return;
  }

  if (field === 'description') {
    draft.description = text.substring(0, 500);
    if (draft.isAgentic) {
      await stepInstructions(ctx, userId);
    } else {
      await stepReview(ctx, userId);
    }
    return;
  }

  if (field === 'instructions') {
    draft.instructions = text.substring(0, 2000);
    await stepReview(ctx, userId);
    return;
  }
}

module.exports = {
  startWizard,
  handleSchedCallback,
  isPendingSchedInput,
  handleSchedText,
};
