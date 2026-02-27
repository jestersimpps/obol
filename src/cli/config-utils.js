const { spawnSync } = require('child_process');

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {object} obj
 * @param {string} path
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

/**
 * @param {object} obj
 * @param {string} path
 * @param {*} value
 */
function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (FORBIDDEN_KEYS.has(keys[i])) return;
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  const lastKey = keys[keys.length - 1];
  if (FORBIDDEN_KEYS.has(lastKey)) return;
  current[lastKey] = value;
}

/**
 * @param {string} value
 * @returns {string}
 */
function maskSecret(value) {
  const str = String(value);
  if (str.length <= 8) return '****';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

/**
 * @param {*} value
 * @param {boolean} secret
 * @returns {string}
 */
function formatValue(value, secret) {
  if (value === undefined || value === null) return '(not set)';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string' && value.startsWith('pass:')) {
    if (!secret) return value;
    const passKey = value.slice(5);
    try {
      const { execSync } = require('child_process');
      const resolved = execSync(`pass show ${passKey}`, { encoding: 'utf-8' }).trim();
      return maskSecret(resolved);
    } catch {
      return '(pass key missing)';
    }
  }
  if (secret) return maskSecret(value);
  return String(value);
}

/**
 * @param {string} passKey
 * @param {string} newValue
 * @returns {boolean}
 */
function updatePassSecret(passKey, newValue) {
  const result = spawnSync('pass', ['insert', '-f', '-m', passKey], {
    input: newValue,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

module.exports = { getNestedValue, setNestedValue, maskSecret, formatValue, updatePassSecret };
