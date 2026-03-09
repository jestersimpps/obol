const { toUTC } = require('../utils');

const definitions = [
  {
    name: 'schedule_event',
    description: `Schedule a one-time or recurring reminder/event. The user will receive a Telegram message each time it fires.

For RECURRING events (e.g. "every 30 minutes", "daily at 9am", "every Monday"):
- ALWAYS use cron_expr — do NOT schedule one-time events and chain them manually
- cron_expr is a standard 5-field cron: minute hour day-of-month month day-of-week
- Examples: "*/30 * * * *" (every 30 min), "0 9 * * 1-5" (weekdays 9am), "0 8 * * 1" (Mondays 8am)
- The system will auto-reschedule after each fire — no need to re-schedule manually

Always search memory first for the user's timezone/location.`,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the reminder/event' },
        due_at: { type: 'string', description: 'ISO 8601 datetime for the first fire time (e.g. 2026-02-25T15:00:00)' },
        timezone: { type: 'string', description: 'IANA timezone (e.g. Europe/Brussels, America/New_York). Default: UTC' },
        description: { type: 'string', description: 'Context or details about the event' },
        cron_expr: { type: 'string', description: 'Cron expression for recurring events (5-field). REQUIRED for any repeating schedule — do not omit and chain one-time events instead.' },
        max_runs: { type: 'number', description: 'Maximum number of times to fire (omit for unlimited)' },
        ends_at: { type: 'string', description: 'ISO 8601 datetime after which the recurring event stops' },
        instructions: { type: 'string', description: 'LLM instructions to execute when the event fires. If set, the bot will run these as an agentic task instead of sending a plain reminder message. Use for automations like "check email", "fetch weather", etc.' },
      },
      required: ['title', 'due_at'],
    },
  },
  {
    name: 'list_events',
    description: 'List scheduled events/reminders for the user.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'sent', 'cancelled', 'completed', 'failed'], description: 'Filter by status (default: pending)' },
        filters: { type: 'object', description: 'PostgREST column filters. Key = column name, value = operator.value. E.g. {"title":"like.*briefing*","cron_expr":"not.is.null","run_count":"gte.5"}', additionalProperties: { type: 'string' } },
        order: { type: 'string', description: 'Sort order: column.direction. E.g. "run_count.desc", "created_at.asc"' },
      },
    },
  },
  {
    name: 'cancel_event',
    description: 'Cancel a scheduled event/reminder by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'UUID of the event to cancel' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'update_event',
    description: 'Update fields on an existing scheduled event. Only provided fields are changed.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'UUID of the event to update' },
        title: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string', description: 'New LLM instructions to execute when the event fires. Only provide if the user wants to change them.' },
        clear_instructions: { type: 'boolean', description: 'Set to true to remove instructions and convert an agentic event to a plain reminder.' },
        timezone: { type: 'string' },
        cron_expr: { type: 'string' },
        max_runs: { type: 'number' },
      },
      required: ['event_id'],
    },
  },
];

const handlers = {
  async schedule_event(input, memory, context) {
    if (!context.scheduler) return 'Scheduler not available (Supabase not configured).';
    const tz = input.timezone || 'UTC';
    const localDate = new Date(input.due_at);
    if (isNaN(localDate.getTime())) return `Invalid date: ${input.due_at}`;

    if (input.cron_expr) {
      try {
        const { CronExpressionParser } = require('cron-parser');
        CronExpressionParser.parse(input.cron_expr, { tz });
      } catch (e) {
        return `Invalid cron expression "${input.cron_expr}": ${e.message}`;
      }
    }

    const utcDate = toUTC(input.due_at, tz);
    const endsAtUtc = input.ends_at ? toUTC(input.ends_at, tz) : null;
    const event = await context.scheduler.add(
      context.chatId, input.title, utcDate, tz,
      input.description || null, input.cron_expr || null,
      input.max_runs || null, endsAtUtc, input.instructions || null
    );
    const displayTime = new Date(utcDate).toLocaleString('en-US', { timeZone: tz });

    const mode = input.instructions ? 'agentic' : 'reminder';

    if (input.cron_expr) {
      let result = `Recurring ${mode} scheduled: "${input.title}"\nFirst run: ${displayTime} (${tz})\nSchedule: ${input.cron_expr}`;
      if (input.max_runs) result += `\nMax runs: ${input.max_runs}`;
      if (input.ends_at) result += `\nEnds: ${new Date(endsAtUtc).toLocaleString('en-US', { timeZone: tz })}`;
      result += `\nID: ${event.id}`;
      return result;
    }

    return `Scheduled ${mode}: "${input.title}" for ${displayTime} (${tz}) — ID: ${event.id}`;
  },

  async list_events(input, memory, context) {
    if (!context.scheduler) return 'Scheduler not available (Supabase not configured).';
    const events = await context.scheduler.list({ status: input.status, filters: input.filters, order: input.order });
    if (events.length === 0) return `No ${input.status || 'pending'} events.`;
    return JSON.stringify(events.map(e => {
      const entry = {
        id: e.id,
        title: e.title,
        description: e.description,
        instructions: e.instructions || null,
        due_at: e.due_at,
        timezone: e.timezone,
        due_local: new Date(e.due_at).toLocaleString('en-US', { timeZone: e.timezone }),
        status: e.status,
        recurring: !!e.cron_expr,
      };
      if (e.cron_expr) {
        entry.cron_expr = e.cron_expr;
        entry.run_count = e.run_count;
        entry.max_runs = e.max_runs;
        entry.ends_at = e.ends_at;
      }
      return entry;
    }));
  },

  async cancel_event(input, memory, context) {
    if (!context.scheduler) return 'Scheduler not available (Supabase not configured).';
    const cancelled = await context.scheduler.cancel(input.event_id);
    if (!cancelled) return `Event not found or not yours: ${input.event_id}`;
    return `Cancelled: "${cancelled.title}"`;
  },

  async update_event(input, memory, context) {
    if (!context.scheduler) return 'Scheduler not available (Supabase not configured).';
    const { event_id, ...rest } = input;
    const fields = {};
    if (rest.title !== undefined) fields.title = rest.title;
    if (rest.description !== undefined) fields.description = rest.description;
    if (rest.clear_instructions === true) fields.instructions = null;
    else if (typeof rest.instructions === 'string' && rest.instructions.length > 0) fields.instructions = rest.instructions;
    if (rest.timezone !== undefined) fields.timezone = rest.timezone;
    if (rest.cron_expr !== undefined) fields.cron_expr = rest.cron_expr;
    if (rest.max_runs !== undefined) fields.max_runs = rest.max_runs;
    if (Object.keys(fields).length === 0) return 'No fields to update.';
    const updated = await context.scheduler.update(event_id, fields);
    if (!updated) return `Event not found or not yours: ${event_id}`;
    return `Updated: "${updated.title}"`;
  },
};

module.exports = { definitions, handlers };
