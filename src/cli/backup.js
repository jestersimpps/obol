const { loadConfig } = require('../config');
const { runBackup } = require('../backup');

async function backup() {
  const config = loadConfig();
  if (!config?.github) {
    console.log('🪙 GitHub backup not configured. Run: obol init');
    return;
  }

  console.log('🪙 Running backup...');
  try {
    await runBackup(config.github);
    console.log('✅ Backup complete');
  } catch (e) {
    console.error(`❌ Backup failed: ${e.message}`);
  }
}

module.exports = { backup };
