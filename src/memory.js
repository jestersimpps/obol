const { pipeline } = require('@xenova/transformers');

let embedderPromise;

async function getEmbedding(text) {
  if (!embedderPromise) {
    console.log('  Loading embedding model (first run downloads ~30MB)...');
    embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2').then(e => {
      console.log('  ✅ Embedding model ready');
      return e;
    });
  }
  const embedder = await embedderPromise;
  const result = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}

async function createMemory(supabaseConfig, userId = 0) {
  const { url, serviceKey } = supabaseConfig;

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  async function add(content, opts = {}) {
    const category = opts.category || 'fact';
    const importance = opts.importance || 0.5;
    const source = opts.source || null;
    const tags = opts.tags || [];

    const embedding = await getEmbedding(content);

    const res = await fetch(`${url}/rest/v1/obol_memory`, {
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

    const res = await fetch(`${url}/rest/v1/rpc/match_obol_memories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query_embedding: embedding,
        match_threshold: threshold,
        match_count: limit,
        filter_category: category,
        filter_user_id: userId !== undefined && userId !== null ? userId : null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

    // Atomically increment access_count and update accessed_at
    if (data.length > 0) {
      const ids = data.map(m => m.id);
      await fetch(`${url}/rest/v1/rpc/increment_memory_access`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ memory_ids: ids }),
      }).catch(() => {}); // Best effort
    }

    return data;
  }

  async function byDate(dateStr, opts = {}) {
    const { start, end } = parseDateRange(dateStr);
    const limit = opts.limit || 50;

    let fetchUrl = `${url}/rest/v1/obol_memory?select=id,content,category,tags,importance,source,created_at&created_at=gte.${start.toISOString()}&created_at=lt.${end.toISOString()}&order=created_at.asc&limit=${limit}&user_id=eq.${userId}`;
    if (opts.category) fetchUrl += `&category=eq.${opts.category}`;

    const res = await fetch(fetchUrl, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  }

  async function recent(opts = {}) {
    const limit = opts.limit || 10;
    let fetchUrl = `${url}/rest/v1/obol_memory?select=id,content,category,tags,importance,source,created_at&order=created_at.desc&limit=${limit}&user_id=eq.${userId}`;
    if (opts.category) fetchUrl += `&category=eq.${opts.category}`;

    const res = await fetch(fetchUrl, { headers });
    if (!res.ok) throw new Error(`Recent failed: HTTP ${res.status}`);
    return await res.json();
  }

  async function update(id, opts = {}) {
    const patch = {};
    if (opts.content !== undefined) {
      patch.content = opts.content;
      patch.embedding = await getEmbedding(opts.content);
    }
    if (opts.category !== undefined) patch.category = opts.category;
    if (opts.importance !== undefined) patch.importance = opts.importance;
    if (opts.tags !== undefined) patch.tags = opts.tags;
    if (opts.source !== undefined) patch.source = opts.source;

    const res = await fetch(`${url}/rest/v1/obol_memory?id=eq.${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data[0];
  }

  async function forget(id) {
    await fetch(`${url}/rest/v1/obol_memory?id=eq.${id}`, {
      method: 'DELETE',
      headers: { ...headers, 'Prefer': 'return=minimal' },
    });
  }

  async function stats() {
    const countHeaders = { ...headers, 'Prefer': 'count=exact' };
    const res = await fetch(`${url}/rest/v1/obol_memory?select=category&user_id=eq.${userId}`, { headers: countHeaders });
    if (!res.ok) throw new Error(`Stats failed: HTTP ${res.status}`);
    const contentRange = res.headers?.get?.('content-range');
    const data = await res.json();
    const total = contentRange ? parseInt(contentRange.split('/')[1], 10) || data.length : data.length;
    const counts = {};
    data.forEach(m => { counts[m.category] = (counts[m.category] || 0) + 1; });
    const breakdown = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `  ${cat}: ${count}`)
      .join('\n');
    return { total, counts, breakdown };
  }

  return { add, search, byDate, recent, update, forget, stats };
}

function parseDateRange(dateStr) {
  let start, end;
  const now = new Date();

  if (!dateStr || dateStr === 'today') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(start); end.setDate(end.getDate() + 1);
  } else if (dateStr === 'yesterday') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (/^(\d+)d$/.test(dateStr)) {
    const days = parseInt(dateStr);
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  } else {
    const parsed = new Date(dateStr);
    if (isNaN(parsed)) throw new Error(`Cannot parse date: ${dateStr}`);
    start = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    end = new Date(start); end.setDate(end.getDate() + 1);
  }

  return { start, end };
}

module.exports = { createMemory, getEmbedding };
