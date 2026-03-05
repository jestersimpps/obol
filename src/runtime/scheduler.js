const { CronExpressionParser } = require('cron-parser');

function createScheduler(supabaseConfig, userId = 0) {
  const { url, serviceKey } = supabaseConfig;

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  async function add(chatId, title, dueAt, timezone = 'UTC', description = null, cronExpr = null, maxRuns = null, endsAt = null, instructions = null) {
    const body = {
      user_id: userId,
      chat_id: chatId,
      title,
      description,
      due_at: dueAt,
      timezone,
      status: 'pending',
    };
    if (cronExpr) body.cron_expr = cronExpr;
    if (maxRuns != null) body.max_runs = maxRuns;
    if (endsAt) body.ends_at = endsAt;
    if (instructions) body.instructions = instructions;
    const res = await fetch(`${url}/rest/v1/obol_events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data[0];
  }

  async function list(opts = {}) {
    const status = opts.status || 'pending';
    const limit = opts.limit || 20;
    let fetchUrl = `${url}/rest/v1/obol_events?user_id=eq.${userId}&status=eq.${status}&order=due_at.asc&limit=${limit}`;
    if (opts.filters) {
      for (const [col, op] of Object.entries(opts.filters)) {
        if (/^[a-z_]+$/.test(col)) fetchUrl += `&${col}=${op}`;
      }
    }
    const res = await fetch(fetchUrl, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  }

  async function cancel(eventId) {
    const res = await fetch(`${url}/rest/v1/obol_events?id=eq.${eventId}&user_id=eq.${userId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'cancelled' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data[0];
  }

  async function getDue() {
    const now = new Date().toISOString();
    const fetchUrl = `${url}/rest/v1/obol_events?status=eq.pending&due_at=lte.${now}`;
    const res = await fetch(fetchUrl, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  }

  async function patch(eventId, fields) {
    const res = await fetch(`${url}/rest/v1/obol_events?id=eq.${eventId}`, {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err);
    }
  }

  async function markSent(eventId) {
    return patch(eventId, { status: 'sent' });
  }

  async function reschedule(eventId, cronExpr, timezone, runCount, maxRuns, endsAt) {
    const newRunCount = (runCount || 0) + 1;

    if (maxRuns && newRunCount >= maxRuns) {
      return patch(eventId, { status: 'completed', run_count: newRunCount, last_run_at: new Date().toISOString() });
    }

    try {
      const nextDate = CronExpressionParser.parse(cronExpr, { currentDate: new Date(), tz: timezone || 'UTC' }).next().toDate();

      if (endsAt && nextDate > new Date(endsAt)) {
        return patch(eventId, { status: 'completed', run_count: newRunCount, last_run_at: new Date().toISOString() });
      }

      return patch(eventId, {
        due_at: nextDate.toISOString(),
        run_count: newRunCount,
        last_run_at: new Date().toISOString(),
        status: 'pending',
      });
    } catch (e) {
      console.error(`[scheduler] Failed to compute next cron occurrence for event ${eventId}:`, e.message);
      return patch(eventId, { status: 'completed', run_count: newRunCount, last_run_at: new Date().toISOString() });
    }
  }

  async function update(eventId, fields) {
    const res = await fetch(`${url}/rest/v1/obol_events?id=eq.${eventId}&user_id=eq.${userId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(fields),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data[0];
  }

  return { add, list, cancel, getDue, markSent, reschedule, update };
}

module.exports = { createScheduler };
