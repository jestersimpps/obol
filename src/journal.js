const MAX_ENTRY_LENGTH = 600;

/**
 * Create a Supabase-backed journal for OBOL's thought log.
 * Table: obol_journal
 *   id          uuid primary key default gen_random_uuid()
 *   user_id     bigint not null default 0
 *   content     text not null
 *   created_at  timestamptz default now()
 *
 * Migration is included in src/db/migrate.js (obol_journal statement).
 */
function createJournal(supabaseConfig, userId = 0) {
  const { url, serviceKey } = supabaseConfig;

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  };

  async function addEntry(content) {
    try {
      const trimmed = content.length > MAX_ENTRY_LENGTH
        ? content.substring(0, MAX_ENTRY_LENGTH) + '...'
        : content;

      const res = await fetch(`${url}/rest/v1/obol_journal`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: trimmed, user_id: userId }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error('[journal] Failed to insert entry:', err);
      }
    } catch (e) {
      console.error('[journal] addEntry error:', e.message);
    }
  }

  async function recent(n = 3) {
    try {
      const userFilter = `&user_id=eq.${userId}`;
      const res = await fetch(
        `${url}/rest/v1/obol_journal?select=content,created_at&order=created_at.desc&limit=${n}${userFilter}`,
        { headers: { ...headers, 'Prefer': 'return=representation' } }
      );
      if (!res.ok) return '';
      const rows = await res.json();
      if (!rows.length) return '';
      // Reverse so oldest-first for natural reading order
      return rows.reverse()
        .map(r => `[${r.created_at.slice(0, 16).replace('T', ' ')}] ${r.content}`)
        .join('\n');
    } catch (e) {
      console.error('[journal] recent error:', e.message);
      return '';
    }
  }

  return { addEntry, recent };
}

module.exports = { createJournal };
