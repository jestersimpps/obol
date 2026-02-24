function createScheduler(supabaseConfig, userId = 0) {
  const { url, serviceKey } = supabaseConfig;

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  async function add(chatId, title, dueAt, timezone = 'UTC', description = null) {
    const res = await fetch(`${url}/rest/v1/obol_events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_id: userId,
        chat_id: chatId,
        title,
        description,
        due_at: dueAt,
        timezone,
        status: 'pending',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data[0];
  }

  async function list(opts = {}) {
    const status = opts.status || 'pending';
    const limit = opts.limit || 20;
    let fetchUrl = `${url}/rest/v1/obol_events?user_id=eq.${userId}&status=eq.${status}&order=due_at.asc&limit=${limit}&select=id,title,description,due_at,timezone,status,created_at`;
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
    const fetchUrl = `${url}/rest/v1/obol_events?status=eq.pending&due_at=lte.${now}&select=id,user_id,chat_id,title,description,due_at,timezone`;
    const res = await fetch(fetchUrl, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  }

  async function markSent(eventId) {
    const res = await fetch(`${url}/rest/v1/obol_events?id=eq.${eventId}`, {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: 'sent' }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err);
    }
  }

  return { add, list, cancel, getDue, markSent };
}

module.exports = { createScheduler };
