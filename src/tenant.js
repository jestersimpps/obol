const { ensureUserDir } = require('./config');
const { loadPersonality } = require('./personality');
const { createMemory } = require('./memory');
const { createClaude } = require('./claude');
const { createMessageLog } = require('./messages');
const { BackgroundRunner } = require('./background');
const path = require('path');

const tenants = new Map();

async function getTenant(userId, config) {
  if (tenants.has(userId)) return tenants.get(userId);

  const userDir = ensureUserDir(userId);
  const personalityDir = path.join(userDir, 'personality');
  const personality = loadPersonality(personalityDir);
  const memory = config.supabase ? await createMemory(config.supabase, userId) : null;
  const claude = createClaude(config.anthropic, { personality, memory, userDir });
  const messageLog = config.supabase ? createMessageLog(config.supabase, memory, claude.client, userId, userDir) : null;
  const bg = new BackgroundRunner();

  const tenant = { claude, memory, messageLog, personality, bg, userDir, userId };
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
