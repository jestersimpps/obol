const { exec } = require('child_process');
const path = require('path');
const { URL } = require('url');
const net = require('net');

const NPM_PACKAGE_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[^\s]+)?$/;

function isValidNpmPackage(dep) {
  return typeof dep === 'string' && dep.length < 214 && NPM_PACKAGE_RE.test(dep);
}

function isPathInsideDir(inputPath, baseDir) {
  const resolved = path.resolve(baseDir, inputPath);
  const normalizedBase = path.resolve(baseDir) + path.sep;
  return resolved === path.resolve(baseDir) || resolved.startsWith(normalizedBase);
}

function isAllowedUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return false;

  const hostname = parsed.hostname.toLowerCase();

  if (['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(hostname)) return false;
  if (hostname === '169.254.169.254') return false;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;

  if (net.isIP(hostname)) {
    const parts = hostname.split('.').map(Number);
    if (parts[0] === 10) return false;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    if (parts[0] === 192 && parts[1] === 168) return false;
    if (parts[0] === 0) return false;
  }

  return true;
}

function execAsync(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

module.exports = { isValidNpmPackage, isPathInsideDir, isAllowedUrl, execAsync };
