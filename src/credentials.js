const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getUserDir } = require('./config');

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

function validateKey(key) {
  if (!key || typeof key !== 'string') throw new Error('Key is required');
  if (!KEY_PATTERN.test(key)) {
    throw new Error('Key must be 1-64 chars: letters, numbers, hyphens, dots, underscores');
  }
}

function hasPassStore() {
  try {
    execFileSync('which', ['pass'], { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function passPrefix(userId) {
  return `obol/users/${userId}`;
}

function secretsJsonPath(userId) {
  const dir = getUserDir(userId);
  return path.join(dir, 'secrets.json');
}

function loadSecretsJson(userId) {
  const p = secretsJsonPath(userId);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSecretsJson(userId, data) {
  const p = secretsJsonPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function storeSecret(userId, key, value) {
  validateKey(key);
  if (!value || typeof value !== 'string') throw new Error('Value is required');

  if (hasPassStore()) {
    const passKey = `${passPrefix(userId)}/${key}`;
    execFileSync('pass', ['insert', '--force', '--multiline', passKey], {
      input: value,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return;
  }

  const secrets = loadSecretsJson(userId);
  secrets[key] = value;
  saveSecretsJson(userId, secrets);
}

function readSecret(userId, key) {
  validateKey(key);

  if (hasPassStore()) {
    try {
      const passKey = `${passPrefix(userId)}/${key}`;
      return execFileSync('pass', ['show', passKey], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }
  }

  const secrets = loadSecretsJson(userId);
  return secrets[key] || null;
}

function removeSecret(userId, key) {
  validateKey(key);

  if (hasPassStore()) {
    try {
      const passKey = `${passPrefix(userId)}/${key}`;
      execFileSync('pass', ['rm', '--force', passKey], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {}
    return;
  }

  const secrets = loadSecretsJson(userId);
  delete secrets[key];
  saveSecretsJson(userId, secrets);
}

function listSecrets(userId) {
  if (hasPassStore()) {
    try {
      const prefix = passPrefix(userId);
      const output = execFileSync('pass', ['ls', prefix], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.split('\n')
        .map(line => line.replace(/[│├└──\s]/g, '').replace(/\.gpg$/, '').trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  const secrets = loadSecretsJson(userId);
  return Object.keys(secrets);
}

module.exports = { storeSecret, readSecret, removeSecret, listSecrets, hasPassStore, validateKey };
