const { ensureUserDir } = require('./config');
const { PERSONALITY_DIR } = require('./soul');
const { loadPersonality } = require('./personality');
const { createMemory } = require('./memory');
const { createSelfMemory } = require('./memory-self');
const { createPatterns } = require('./patterns');
const { createClaude } = require('./claude');
const { createMessageLog } = require('./messages');
const { BackgroundRunner } = require('./background');
const { isBridgeEnabled } = require('./bridge');
const { createScheduler } = require('./scheduler');
const { createToolPrefs } = require('./toolprefs');
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
  const personality = loadPersonality(PERSONALITY_DIR, path.join(userDir, 'personality'));
  const memory = config.supabase ? await createMemory(config.supabase, userId) : null;
  const selfMemory = config.supabase ? await createSelfMemory(config.supabase, userId) : null;
  const patterns = config.supabase ? await createPatterns(config.supabase, userId) : null;
  const bridgeEnabled = isBridgeEnabled(config) && (config.telegram?.allowedUsers?.length || 0) >= 2;
  const claude = createClaude(config.anthropic, { personality, memory, selfMemory, userDir, bridgeEnabled, botName: config.bot?.name });
  const scheduler = config.supabase ? createScheduler(config.supabase, userId) : null;
  const messageLog = config.supabase ? createMessageLog(config.supabase, memory, config.anthropic, userId, userDir) : null;
  const toolPrefsApi = config.supabase ? createToolPrefs(config.supabase, userId) : null;
  const bg = new BackgroundRunner();

  let toolPrefs = new Map();
  if (toolPrefsApi) {
    try { toolPrefs = await toolPrefsApi.getAll(); } catch {}
  }

  if (messageLog) {
    try {
      const recent = await messageLog.getRecent(userId, 50);
      for (const row of recent) {
        claude.injectHistory(userId, row.role, row.content);
      }
    } catch {}
  }

  let personalityMtime = 0;
  try {
    personalityMtime = fs.statSync(path.join(PERSONALITY_DIR, 'SOUL.md')).mtimeMs;
  } catch {}

  return {
    claude, memory, selfMemory, patterns, messageLog, personality, scheduler, bg, userDir, userId,
    toolPrefs,
    toolPrefsApi,
    async reloadToolPrefs() {
      if (toolPrefsApi) {
        try { this.toolPrefs = await toolPrefsApi.getAll(); } catch {}
      }
    },
    verbose: false,
    _personalityLoadedAt: Date.now(),
    _personalityMtime: personalityMtime,
  };
}

async function getTenant(userId, config) {
  if (tenants.has(userId)) {
    const tenant = tenants.get(userId);
    if (Date.now() - (tenant._personalityLoadedAt || 0) > PERSONALITY_CACHE_TTL) {
      try {
        const soulPath = path.join(PERSONALITY_DIR, 'SOUL.md');
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
