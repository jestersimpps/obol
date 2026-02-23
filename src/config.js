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
      try {
        const { execSync } = require('child_process');
        result[key] = execSync(`pass show ${result[key].slice(5)}`, { encoding: 'utf-8' }).trim();
      } catch {
        // pass not available or key missing — keep the placeholder
      }
    } else if (typeof result[key] === 'object') {
      result[key] = resolvePassValues(result[key]);
    }
  }
  return result;
}

function loadConfig({ resolve = true } = {}) {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(raw);
    return resolve ? resolvePassValues(config) : config;
  } catch {
    return null;
  }
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
  for (const sub of ['personality', 'scripts', 'tests', 'commands', 'apps', 'logs']) {
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
