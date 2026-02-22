const fs = require('fs');
const { PID_FILE, loadConfig } = require('../config');

async function status() {
  const config = loadConfig();

  console.log('🪙 OBOL Status\n');

  // Config
  if (!config) {
    console.log('  ⚠️  Not configured. Run: obol init');
    return;
  }
  console.log('  ✅ Configured');

  // Running?
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'));
    try {
      process.kill(pid, 0);
      console.log(`  ✅ Running (PID ${pid})`);
    } catch {
      console.log('  ❌ Not running (stale PID file)');
    }
  } else {
    console.log('  ❌ Not running');
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
