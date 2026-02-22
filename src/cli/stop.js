const fs = require('fs');
const { PID_FILE } = require('../config');

async function stop() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('🪙 Not running.');
    return;
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'));
  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_FILE);
    console.log(`🪙 Stopped (PID ${pid})`);
  } catch {
    fs.unlinkSync(PID_FILE);
    console.log('🪙 Process already stopped. Cleaned up PID file.');
  }
}

module.exports = { stop };
