const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('../config');

const PERSONALITY_DIR = path.join(OBOL_DIR, 'personality');

function makeHeaders(supabaseConfig) {
  return {
    'apikey': supabaseConfig.serviceKey,
    'Authorization': `Bearer ${supabaseConfig.serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  };
}

async function backup(supabaseConfig, key, content) {
  if (!supabaseConfig?.url || !supabaseConfig?.serviceKey) return;
  await fetch(`${supabaseConfig.url}/rest/v1/obol_soul`, {
    method: 'POST',
    headers: makeHeaders(supabaseConfig),
    body: JSON.stringify({ id: key, content, updated_at: new Date().toISOString() }),
  });
}

async function restore(supabaseConfig) {
  if (!supabaseConfig?.url || !supabaseConfig?.serviceKey) return null;
  const res = await fetch(`${supabaseConfig.url}/rest/v1/obol_soul?id=like.soul%25&order=updated_at.desc&limit=1&select=content`, {
    headers: makeHeaders(supabaseConfig),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows?.[0]?.content || null;
}

async function restoreIfMissing(supabaseConfig) {
  if (!supabaseConfig?.url || !supabaseConfig?.serviceKey) return;
  fs.mkdirSync(PERSONALITY_DIR, { recursive: true });

  const soulPath = path.join(PERSONALITY_DIR, 'SOUL.md');
  if (!fs.existsSync(soulPath)) {
    try {
      const content = await restore(supabaseConfig);
      if (content) {
        fs.writeFileSync(soulPath, content);
        console.log('  [soul] Restored SOUL.md from Supabase');
      }
    } catch (e) {
      console.error(`  [soul] Failed to restore SOUL.md: ${e.message}`);
    }
  }
}

module.exports = { backup, restore, restoreIfMissing, PERSONALITY_DIR };
