const { ensureUserDir } = require('./config');
const { loadPersonality } = require('./personality');
const { createMemory } = require('./memory');
const { createClaude } = require('./claude');
const { createMessageLog } = require('./messages');
const { BackgroundRunner } = require('./background');
const { isBridgeEnabled } = require('./bridge');
const fs = require('fs');
const path = require('path');

const tenants = new Map();
const PERSONALITY_CACHE_TTL = 60000;

async function getTenant(userId, config) {
  if (tenants.has(userId)) {
    const tenant = tenants.get(userId);
    if (Date.now() - (tenant._personalityLoadedAt || 0) > PERSONALITY_CACHE_TTL) {
      const personalityDir = path.join(tenant.userDir, 'personality');
      try {
        const soulPath = path.join(personalityDir, 'SOUL.md');
        const mtime = fs.statSync(soulPath).mtimeMs;
        if (mtime > (tenant._personalityMtime || 0)) {
          tenant.claude.reloadPersonality();
          tenant._personalityMtime = mtime;
        }
      } catch {}
      tenant._personalityLoadedAt = Date.now();
    }
    return tenant;
  }

  const userDir = ensureUserDir(userId);
  const personalityDir = path.join(userDir, 'personality');
  const personality = loadPersonality(personalityDir);
  const memory = config.supabase ? await createMemory(config.supabase, userId) : null;
  const bridgeEnabled = isBridgeEnabled(config) && (config.telegram?.allowedUsers?.length || 0) >= 2;
  const claude = createClaude(config.anthropic, { personality, memory, userDir, bridgeEnabled });
  const messageLog = config.supabase ? createMessageLog(config.supabase, memory, claude.client, userId, userDir) : null;
  const bg = new BackgroundRunner();

  let personalityMtime = 0;
  try {
    personalityMtime = fs.statSync(path.join(personalityDir, 'SOUL.md')).mtimeMs;
  } catch {}

  const tenant = {
    claude, memory, messageLog, personality, bg, userDir, userId,
    _personalityLoadedAt: Date.now(),
    _personalityMtime: personalityMtime,
  };
  tenants.set(userId, tenant);
  return tenant;
}

function clearTenant(userId) {
  tenants.delete(userId);
}

function getAllTenants() {
  return tenants;
}

module.exports = { getTenant, clearTenant, getAllTenants };
