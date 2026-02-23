const { execSync } = require('child_process');
const { loadConfig } = require('../config');

async function status() {
  const config = loadConfig();

  console.log('🪙 OBOL Status\n');

  if (!config) {
    console.log('  ⚠️  Not configured. Run: obol init');
    return;
  }
  console.log('  ✅ Configured');

  // Check pm2
  try {
    const list = execSync('pm2 jlist', { encoding: 'utf-8' });
    const procs = JSON.parse(list);
    const obol = procs.find(p => p.name === 'obol');
    if (obol) {
      const status = obol.pm2_env.status;
      const uptime = obol.pm2_env.pm_uptime ? Math.floor((Date.now() - obol.pm2_env.pm_uptime) / 60000) : 0;
      const restarts = obol.pm2_env.restart_time || 0;
      const mem = (obol.monit?.memory / 1024 / 1024).toFixed(0) || '?';
      console.log(`  ${status === 'online' ? '✅' : '❌'} Process: ${status} (PID ${obol.pid})`);
      console.log(`  ⏱️  Uptime: ${uptime}min | Restarts: ${restarts} | Memory: ${mem}MB`);
    } else {
      console.log('  ❌ Not running');
    }
  } catch {
    console.log('  ❌ Not running (pm2 not installed)');
  }

  // Components
  console.log(`  📡 Telegram: ${config.telegram ? 'configured' : 'not set'}`);
  console.log(`  🧠 Anthropic: ${config.anthropic ? 'configured' : 'not set'}`);
  console.log(`  💾 Memory: ${config.supabase ? 'configured' : 'disabled'}`);
  console.log(`  📦 Backup: ${config.github ? `${config.github.username}/${config.github.repo}` : 'disabled'}`);
  console.log(`  🚀 Vercel: ${config.vercel ? 'configured' : 'not set'}`);
  console.log(`  👤 Owner: ${config.owner?.name || 'not set'}`);
  console.log(`  🤖 Bot: ${config.bot?.name || 'OBOL'}`);
}

module.exports = { status };
