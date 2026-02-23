const { loadConfig, PID_FILE } = require('../config');
const { execSync } = require('child_process');
const path = require('path');

async function start(opts = {}) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    console.error(`  ❌ Node.js 18+ required (you have ${process.version})`);
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    console.error('🪙 Not configured. Run: obol init');
    process.exit(1);
  }

  if (opts.daemon) {
    // Check if pm2 is available
    try {
      execSync('which pm2', { stdio: 'pipe' });
    } catch {
      console.log('Installing pm2...');
      execSync('npm install -g pm2', { stdio: 'inherit' });
    }

    // Check if already running
    try {
      const list = execSync('pm2 jlist', { encoding: 'utf-8' });
      const procs = JSON.parse(list);
      const obol = procs.find(p => p.name === 'obol');
      if (obol && obol.pm2_env.status === 'online') {
        console.log('🪙 Already running. Use: pm2 restart obol');
        return;
      }
    } catch {}

    // Start with pm2
    const entryPoint = path.join(__dirname, '..', 'index.js');
    execSync(`pm2 start ${entryPoint} --name obol`, { stdio: 'inherit' });
    console.log('\n🪙 OBOL started with pm2');
    console.log('   pm2 logs obol     — tail logs');
    console.log('   pm2 restart obol  — restart');
    console.log('   pm2 stop obol     — stop');
    console.log('   pm2 startup && pm2 save — auto-start on boot');
  } else {
    // Foreground mode
    console.log('🪙 Starting in foreground (Ctrl+C to stop)...\n');
    try {
      require('../index');
    } catch (e) {
      console.error(`Startup failed: ${e.message}`);
      process.exit(1);
    }
  }
}

module.exports = { start };
