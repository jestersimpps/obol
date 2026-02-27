const fs = require('fs');
const path = require('path');
const os = require('os');
const { deriveKey, encrypt, decrypt } = require('./auth/encrypt');

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
        const { execFileSync } = require('child_process');
        result[key] = execFileSync('pass', ['show', passKey], { encoding: 'utf-8' }).trim();
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

const SENSITIVE_PATHS = [
  'anthropic.apiKey',
  'anthropic.oauth.accessToken',
  'anthropic.oauth.refreshToken',
  'telegram.token',
  'supabase.serviceKey',
  'supabase.accessToken',
  'github.token',
  'vercel.token',
];

function configKey() {
  return deriveKey('obol-config');
}

function getPath(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => o?.[k], obj);
}

function setPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') return;
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function encryptSensitiveFields(config) {
  const key = configKey();
  const copy = JSON.parse(JSON.stringify(config));
  for (const p of SENSITIVE_PATHS) {
    const val = getPath(copy, p);
    if (typeof val === 'string' && val && !val.startsWith('pass:')) {
      setPath(copy, p, encrypt(val, key));
    }
  }
  return copy;
}

const ENCRYPTED_RE = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/;

function decryptSensitiveFields(config) {
  const key = configKey();
  let hadPlaintext = false;
  for (const p of SENSITIVE_PATHS) {
    const val = getPath(config, p);
    if (typeof val === 'string' && val && !val.startsWith('pass:')) {
      if (ENCRYPTED_RE.test(val)) {
        try {
          setPath(config, p, decrypt(val, key));
        } catch {
          setPath(config, p, null);
          console.warn(`[config] Could not decrypt ${p} — hostname may have changed. Run: obol config`);
        }
      } else {
        hadPlaintext = true;
      }
    }
  }
  if (hadPlaintext) {
    const encrypted = encryptSensitiveFields(config);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  }
  return config;
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
  decryptSensitiveFields(config);
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
  const encrypted = encryptSensitiveFields(config);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
}

function getUserDir(userId) {
  return path.join(USERS_DIR, String(userId));
}

function ensureUserDir(userId) {
  const dir = getUserDir(userId);
  for (const sub of ['personality', 'scripts', 'tests', 'commands', 'apps', 'logs', 'assets', 'library']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  const defaultAgents = path.join(__dirname, 'defaults', 'AGENTS.md');
  const targetAgents = path.join(dir, 'personality', 'AGENTS.md');
  if (fs.existsSync(defaultAgents) && !fs.existsSync(targetAgents)) {
    fs.copyFileSync(defaultAgents, targetAgents);
  }
  return dir;
}

/** @param {object} config @param {number|string} userId @returns {string} */
function getUserTimezone(config, userId) {
  return config.users?.[String(userId)]?.timezone || config.timezone || 'UTC';
}

function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch { return false; }
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
  resolvePassValues,
  loadConfig,
  saveConfig,
  getUserDir,
  ensureUserDir,
  listUsers,
  getUserTimezone,
  isValidTimezone,
};
