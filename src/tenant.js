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
const pendingTenants = new Map();
const PERSONALITY_CACHE_TTL = 60000;
const TENANT_INACTIVE_TTL = 3600000;

const _tenantCleanup = setInterval(() => {
  const now = Date.now();
  for (const [userId, tenant] of tenants) {
    if (now - (tenant._personalityLoadedAt || 0) > TENANT_INACTIVE_TTL) {
      for (const task of tenant.bg.tasks?.values() || []) {
        if (task.checkInTimer) { clearInterval(task.checkInTimer); task.checkInTimer = null; }
      }
      tenants.delete(userId);
    }
  }
}, 600000);
_tenantCleanup.unref();

async function createTenant(userId, config) {
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

  return {
    claude, memory, messageLog, personality, bg, userDir, userId,
    verbose: false,
    _personalityLoadedAt: Date.now(),
    _personalityMtime: personalityMtime,
  };
}

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

  if (pendingTenants.has(userId)) {
    return pendingTenants.get(userId);
  }

  const promise = createTenant(userId, config).then(tenant => {
    tenants.set(userId, tenant);
    pendingTenants.delete(userId);
    return tenant;
  }).catch(err => {
    pendingTenants.delete(userId);
    throw err;
  });
  pendingTenants.set(userId, promise);
  return promise;
}

function clearTenant(userId) {
  const tenant = tenants.get(userId);
  if (tenant?.bg?.tasks) {
    for (const task of tenant.bg.tasks.values()) {
      if (task.checkInTimer) { clearInterval(task.checkInTimer); task.checkInTimer = null; }
    }
  }
  tenants.delete(userId);
}

function getAllTenants() {
  return tenants;
}

module.exports = { getTenant, clearTenant, getAllTenants };
