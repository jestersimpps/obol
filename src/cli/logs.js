const { execSync } = require('child_process');

async function logs(opts = {}) {
  const lines = opts.lines || 50;
  try {
    execSync(`pm2 logs obol --lines ${lines}`, { stdio: 'inherit' });
  } catch {
    console.log('🪙 Not running (or pm2 not installed). Start with: obol start -d');
  }
}

module.exports = { logs };
