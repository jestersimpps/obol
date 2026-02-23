const { execSync } = require('child_process');
const fs = require('fs');
const { LOG_FILE } = require('../config');

function hasPm2() {
  try {
    execSync('which pm2', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function logs(opts = {}) {
  const lines = opts.lines || 50;

  if (hasPm2()) {
    try {
      execSync(`pm2 logs obol --lines ${lines}`, { stdio: 'inherit' });
      return;
    } catch {}
  }

  if (fs.existsSync(LOG_FILE)) {
    console.log(`📄 Reading ${LOG_FILE}\n`);
    try {
      execSync(`tail -n ${lines} "${LOG_FILE}"`, { stdio: 'inherit' });
    } catch (e) {
      console.error(`  ❌ Failed to read log file: ${e.message}`);
    }
    return;
  }

  console.log('🪙 No logs found.');
  if (!hasPm2()) {
    console.log('  pm2 is not installed. Install with: npm install -g pm2');
    console.log('  Or start with: obol start (foreground) to see logs directly');
  }
}

module.exports = { logs };
