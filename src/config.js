const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const OBOL_DIR = path.join(os.homedir(), '.obol');
const USERS_DIR = path.join(OBOL_DIR, 'users');
const CONFIG_FILE = path.join(OBOL_DIR, 'config.json');
const PID_FILE = path.join(OBOL_DIR, 'obol.pid');
const LOG_FILE = path.join(OBOL_DIR, 'logs', 'obol.log');

function getConfigDir() {
  return OBOL_DIR;
}

function resolvePassValues(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(result)) {
    if (typeof result[key] === 'string' && result[key].startsWith('pass:')) {
      const passKey = result[key].slice(5);
      try {
        const { execSync } = require('child_process');
        result[key] = execSync(`pass show ${passKey}`, { encoding: 'utf-8' }).trim();
      } catch (e) {
        const reason = e.message?.includes('not found') ? 'key not found' : 'pass not installed or unavailable';
        console.error(`[config] Failed to resolve ${passKey} — ${reason}`);
        result[key] = null;
      }
    } else if (typeof result[key] === 'object') {
      result[key] = resolvePassValues(result[key]);
    }
  }
  return result;
}

function loadConfig({ resolve = true } = {}) {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  } catch (e) {
    console.error(`[config] Cannot read ${CONFIG_FILE}: ${e.message}`);
    return null;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    console.error(`[config] ${CONFIG_FILE} is corrupted (invalid JSON): ${e.message}`);
    console.error('[config] Fix the file manually or run: obol init --reset');
    return null;
  }
  const warnings = validateConfigSchema(config);
  if (warnings.length > 0) {
    for (const w of warnings) console.warn(`[config] ${w}`);
  }
  return resolve ? resolvePassValues(config) : config;
}

function validateConfigSchema(config) {
  const warnings = [];
  if (!config.anthropic?.apiKey && !config.anthropic?.oauth?.accessToken) {
    warnings.push('Missing Anthropic credentials — run: obol config');
  }
  if (!config.telegram?.token) {
    warnings.push('Missing Telegram bot token — run: obol config');
  }
  if (!config.telegram?.allowedUsers?.length) {
    warnings.push('No allowed users — bot will reject all messages. Run: obol config');
  }
  return warnings;
}

function saveConfig(config) {
  fs.mkdirSync(OBOL_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function getUserDir(userId) {
  return path.join(USERS_DIR, String(userId));
}

function ensureUserDir(userId) {
  const dir = getUserDir(userId);
  for (const sub of ['personality', 'scripts', 'tests', 'commands', 'apps', 'logs', 'assets']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function listUsers() {
  if (!fs.existsSync(USERS_DIR)) return [];
  return fs.readdirSync(USERS_DIR).filter(f =>
    fs.statSync(path.join(USERS_DIR, f)).isDirectory()
  );
}

module.exports = {
  OBOL_DIR,
  USERS_DIR,
  CONFIG_FILE,
  PID_FILE,
  LOG_FILE,
  getConfigDir,
  loadConfig,
  saveConfig,
  getUserDir,
  ensureUserDir,
  listUsers,
};
