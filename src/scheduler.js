const { parseExpression } = require('cron-parser');

function createScheduler(supabaseConfig, userId = 0) {
  const { url, serviceKey } = supabaseConfig;

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  async function add(chatId, title, dueAt, timezone = 'UTC', description = null, cronExpr = null, maxRuns = null, endsAt = null) {
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
    const fetchUrl = `${url}/rest/v1/obol_events?user_id=eq.${userId}&status=eq.${status}&order=due_at.asc&limit=${limit}&select=id,title,description,due_at,timezone,status,created_at,cron_expr,last_run_at,run_count,max_runs,ends_at`;
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
    const fetchUrl = `${url}/rest/v1/obol_events?status=eq.pending&due_at=lte.${now}&select=id,user_id,chat_id,title,description,due_at,timezone,cron_expr,run_count,max_runs,ends_at`;
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
      const nextDate = parseExpression(cronExpr, { currentDate: new Date(), timezone: timezone || 'UTC' }).next().toDate();

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

  return { add, list, cancel, getDue, markSent, reschedule };
}

module.exports = { createScheduler };
