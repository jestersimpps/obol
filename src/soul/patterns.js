const VALID_DIMENSIONS = new Set(['timing', 'mood', 'humor', 'engagement', 'communication', 'topics']);

async function createPatterns(supabaseConfig, userId) {
  const { url, serviceKey } = supabaseConfig;

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  async function upsert(key, dimension, summary, data = {}, confidence = 0.5) {
    if (!VALID_DIMENSIONS.has(dimension)) throw new Error(`Invalid dimension: ${dimension}`);

    const res = await fetch(`${url}/rest/v1/obol_user_patterns`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        user_id: userId,
        key,
        dimension,
        summary,
        data,
        confidence,
        updated_at: new Date().toISOString(),
        observation_count: 1,
      }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(result));
    return result[0];
  }

  async function incrementObservation(key, dimension, summary, data = {}, confidence = 0.5) {
    const existing = await get(key);
    const count = (existing?.observation_count || 0) + 1;

    const res = await fetch(`${url}/rest/v1/obol_user_patterns`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        user_id: userId,
        key,
        dimension,
        summary,
        data,
        confidence,
        observation_count: count,
        updated_at: new Date().toISOString(),
      }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(result));
    return result[0];
  }

  async function get(key) {
    const res = await fetch(
      `${url}/rest/v1/obol_user_patterns?user_id=eq.${userId}&key=eq.${encodeURIComponent(key)}&limit=1`,
      { headers }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data[0] || null;
  }

  async function getAll() {
    const res = await fetch(
      `${url}/rest/v1/obol_user_patterns?user_id=eq.${userId}&order=dimension.asc,updated_at.desc`,
      { headers }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  }

  async function getByDimension(dimension) {
    const res = await fetch(
      `${url}/rest/v1/obol_user_patterns?user_id=eq.${userId}&dimension=eq.${dimension}&order=updated_at.desc`,
      { headers }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  }

  async function remove(key) {
    await fetch(
      `${url}/rest/v1/obol_user_patterns?user_id=eq.${userId}&key=eq.${encodeURIComponent(key)}`,
      { method: 'DELETE', headers: { ...headers, 'Prefer': 'return=minimal' } }
    );
  }

  async function format() {
    const all = await getAll();
    if (!all.length) return null;
    const byDimension = {};
    for (const p of all) {
      if (!byDimension[p.dimension]) byDimension[p.dimension] = [];
      byDimension[p.dimension].push(p.summary);
    }
    return Object.entries(byDimension)
      .map(([dim, summaries]) => `[${dim}]\n${summaries.map(s => `- ${s}`).join('\n')}`)
      .join('\n\n');
  }

  return { upsert, incrementObservation, get, getAll, getByDimension, remove, format };
}

module.exports = { createPatterns };
