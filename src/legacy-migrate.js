const fs = require('fs');
const path = require('path');
const { OBOL_DIR, USERS_DIR, ensureUserDir } = require('./config');

async function migrateToMultiTenant(config) {
  if (fs.existsSync(USERS_DIR) && fs.readdirSync(USERS_DIR).length > 0) return;

  const personalityDir = path.join(OBOL_DIR, 'personality');
  if (!fs.existsSync(personalityDir)) return;

  const allowedUsers = config.telegram?.allowedUsers || [];
  if (allowedUsers.length === 0) return;

  const userId = allowedUsers[0];
  console.log(`  Migrating to multi-tenant for user ${userId}...`);

  const userDir = ensureUserDir(userId);

  const moveDirs = ['personality', 'scripts', 'tests', 'commands', 'apps'];
  for (const dir of moveDirs) {
    const src = path.join(OBOL_DIR, dir);
    const dst = path.join(userDir, dir);
    if (fs.existsSync(src)) {
      copyDirRecursive(src, dst);
    }
  }

  const stateFiles = ['.evolution-state.json', '.first-run-complete', '.post-setup-complete'];
  for (const file of stateFiles) {
    const src = path.join(OBOL_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(userDir, file));
    }
  }

  if (config.supabase) {
    try {
      const { url, serviceKey } = config.supabase;
      const headers = {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      };

      await fetch(`${url}/rest/v1/obol_memory?user_id=eq.0`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ user_id: userId }),
      });

      await fetch(`${url}/rest/v1/obol_messages?user_id=eq.0`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ user_id: userId }),
      });

      console.log(`  ✅ DB records migrated to user_id=${userId}`);
    } catch (e) {
      console.error(`  ⚠️  DB migration failed: ${e.message}`);
    }
  }

  console.log(`  ✅ Legacy migration complete → ~/.obol/users/${userId}/`);
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

module.exports = { migrateToMultiTenant };
