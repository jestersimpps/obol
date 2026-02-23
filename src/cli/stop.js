const { execSync } = require('child_process');
const fs = require('fs');
const { PID_FILE } = require('../config');

function hasPm2() {
  try {
    execSync('which pm2', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function stop() {
  if (hasPm2()) {
    try {
      execSync('pm2 stop obol', { stdio: 'inherit' });
      console.log('🪙 Stopped');
      return;
    } catch {}
  }

  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(PID_FILE);
      console.log('🪙 Stopped (pid ' + pid + ')');
      return;
    } catch (e) {
      fs.unlinkSync(PID_FILE);
    }
  }

  console.log('🪙 Not running.');
  if (!hasPm2()) {
    console.log('  Tip: install pm2 globally for daemon mode — npm install -g pm2');
  }
}

module.exports = { stop };
