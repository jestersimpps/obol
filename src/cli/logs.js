const { execSync } = require('child_process');
const fs = require('fs');
const { LOG_FILE } = require('../config');

async function logs(opts = {}) {
  if (!fs.existsSync(LOG_FILE)) {
    console.log('🪙 No logs yet. Start the bot first: obol start');
    return;
  }

  const lines = opts.lines || 50;
  try {
    execSync(`tail -n ${lines} -f ${LOG_FILE}`, { stdio: 'inherit' });
  } catch {
    // User pressed Ctrl+C
  }
}

module.exports = { logs };
