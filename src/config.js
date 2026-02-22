const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const OBOL_DIR = path.join(os.homedir(), '.obol');
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

module.exports = {
  OBOL_DIR,
  CONFIG_FILE,
  PID_FILE,
  LOG_FILE,
  getConfigDir,
  loadConfig,
  saveConfig,
};
