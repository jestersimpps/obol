function createToolPrefs(supabaseConfig, userId) {
  const { url, serviceKey } = supabaseConfig;

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  async function getAll() {
    const res = await fetch(
      `${url}/rest/v1/obol_tool_prefs?user_id=eq.${userId}&select=tool_name,enabled,config`,
      { headers },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    const map = new Map();
    for (const row of data) {
      map.set(row.tool_name, { enabled: row.enabled, config: row.config || {} });
    }
    return map;
  }

  async function set(toolName, enabled, config = {}) {
    const res = await fetch(`${url}/rest/v1/obol_tool_prefs`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify({
        user_id: userId,
        tool_name: toolName,
        enabled,
        config,
        updated_at: new Date().toISOString(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data[0];
  }

  async function toggle(toolName) {
    const all = await getAll();
    const current = all.get(toolName);
    const newEnabled = !(current?.enabled);
    await set(toolName, newEnabled, current?.config || {});
    return newEnabled;
  }

  return { getAll, set, toggle };
}

module.exports = { createToolPrefs };
