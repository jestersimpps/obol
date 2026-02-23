const { execSync } = require('child_process');

async function stop() {
  try {
    execSync('pm2 stop obol', { stdio: 'inherit' });
    console.log('🪙 Stopped');
  } catch {
    console.log('🪙 Not running (or pm2 not installed).');
  }
}

module.exports = { stop };
