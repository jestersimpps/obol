const { getEmbedding } = require('./index');

const VALID_CATEGORIES = new Set(['research', 'interest', 'self', 'pattern']);

async function createSelfMemory(supabaseConfig, userId) {
  const { url, serviceKey } = supabaseConfig;

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  async function add(content, opts = {}) {
    const category = VALID_CATEGORIES.has(opts.category) ? opts.category : 'research';
    const importance = opts.importance || 0.5;
    const source = opts.source || null;
    const tags = opts.tags || [];

    const embedding = await getEmbedding(content);

    const res = await fetch(`${url}/rest/v1/obol_self_memory`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content, category, importance, source, tags, embedding, user_id: userId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data[0];
  }

  async function search(query, opts = {}) {
    const embedding = await getEmbedding(query);
    const limit = opts.limit || 10;
    const threshold = opts.threshold || 0.3;
    const category = opts.category || null;

    const res = await fetch(`${url}/rest/v1/rpc/match_obol_self_memories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query_embedding: embedding,
        match_threshold: threshold,
        match_count: limit,
        filter_category: category,
        filter_user_id: userId,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

    if (data.length > 0) {
      const ids = data.map(m => m.id);
      await fetch(`${url}/rest/v1/rpc/increment_self_memory_access`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ memory_ids: ids }),
      }).catch(() => {});
    }

    return data;
  }

  async function recent(opts = {}) {
    const limit = opts.limit || 10;
    let fetchUrl = `${url}/rest/v1/obol_self_memory?order=created_at.desc&limit=${limit}&user_id=eq.${userId}`;
    if (opts.category) fetchUrl += `&category=eq.${opts.category}`;

    const res = await fetch(fetchUrl, { headers });
    if (!res.ok) throw new Error(`Self memory recent failed: HTTP ${res.status}`);
    return await res.json();
  }

  async function query(opts = {}) {
    const limit = opts.limit || 20;
    const parts = [`user_id=eq.${userId}`];
    if (opts.category) parts.push(`category=eq.${opts.category}`);
    if (opts.source) parts.push(`source=eq.${opts.source}`);
    if (opts.minImportance) parts.push(`importance=gte.${opts.minImportance}`);
    if (opts.tags?.length) parts.push(`tags=ov.{${opts.tags.join(',')}}`);
    if (opts.filters) {
      for (const [col, op] of Object.entries(opts.filters)) {
        if (/^[a-z_]+$/.test(col)) parts.push(`${col}=${op}`);
      }
    }

    const res = await fetch(
      `${url}/rest/v1/obol_self_memory?${parts.join('&')}&order=${opts.order || 'created_at.desc'}&limit=${limit}`,
      { headers }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  }

  async function update(id, opts = {}) {
    const patch = {};
    if (opts.content !== undefined) {
      patch.content = opts.content;
      patch.embedding = await getEmbedding(opts.content);
    }
    if (opts.category !== undefined && VALID_CATEGORIES.has(opts.category)) patch.category = opts.category;
    if (opts.importance !== undefined) patch.importance = opts.importance;
    if (opts.tags !== undefined) patch.tags = opts.tags;
    if (opts.source !== undefined) patch.source = opts.source;

    const res = await fetch(`${url}/rest/v1/obol_self_memory?id=eq.${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data[0];
  }

  async function forget(id) {
    await fetch(`${url}/rest/v1/obol_self_memory?id=eq.${id}`, {
      method: 'DELETE',
      headers: { ...headers, 'Prefer': 'return=minimal' },
    });
  }

  return { add, search, recent, query, update, forget };
}

module.exports = { createSelfMemory };
