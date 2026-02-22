const { loadConfig, PID_FILE, LOG_FILE } = require('../config');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function start(opts = {}) {
  const config = loadConfig();
  if (!config) {
    console.error('🪙 Not configured. Run: obol init');
    process.exit(1);
  }

  // Check if already running
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'));
    try {
      process.kill(pid, 0);
      console.log(`🪙 Already running (PID ${pid}). Use: obol stop`);
      return;
    } catch {
      fs.unlinkSync(PID_FILE); // Stale PID file
    }
  }

  if (opts.daemon) {
    // Daemon mode
    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const child = spawn('node', [path.join(__dirname, '..', 'index.js')], {
      detached: true,
      stdio: ['ignore', logStream, logStream],
      env: { ...process.env },
    });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    console.log(`🪙 OBOL started (PID ${child.pid})`);
    console.log(`   Logs: obol logs`);
  } else {
    // Foreground mode
    console.log('🪙 Starting in foreground (Ctrl+C to stop)...\n');
    require('../index');
  }
}

module.exports = { start };
