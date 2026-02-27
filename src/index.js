const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { createBot, checkUpgradeNotify } = require('./telegram');
const { setupBackup } = require('./backup');
const { setupHeartbeat } = require('./runtime/heartbeat');
const { migrateToMultiTenant } = require('./legacy-migrate');
const { isPostSetupDone, runPostSetup } = require('./post-setup');
const { restoreIfMissing, PERSONALITY_DIR } = require('./soul');

async function main() {
  const config = loadConfig();
  if (!config) {
    console.error('🪙 Not configured. Run: obol init');
    process.exit(1);
  }

  console.log('🪙 OBOL starting...\n');

  await migrateToMultiTenant(config);

  if (config.supabase?.url && config.supabase?.serviceKey) {
    try {
      const { migrate } = require('./db/migrate');
      await migrate(config.supabase);
      console.log('  Database ready');
    } catch (e) {
      console.error(`  Database migration failed: ${e.message}`);
    }

    try {
      await restoreIfMissing(config.supabase);
    } catch (e) {
      console.error(`  Soul restore failed: ${e.message}`);
    }
  }

  fs.mkdirSync(PERSONALITY_DIR, { recursive: true });

  if (!isPostSetupDone()) {
    runPostSetup(loadConfig({ resolve: false }), console.log).catch(e =>
      console.error('Post-setup error:', e.message)
    );
  }

  const bot = createBot(config.telegram, config);

  checkUpgradeNotify(bot).catch(() => {});

  if (config.heartbeat !== false) {
    setupHeartbeat(bot, config);
  }

  if (config.github) {
    setupBackup(config.github);
  }

  const shutdown = async (signal) => {
    console.log(`\n🪙 ${signal} received. Shutting down gracefully...`);
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('🪙 OBOL is alive. Listening for messages...\n');
  await bot.start({
    onStart: (info) => console.log(`  Bot: @${info.username}`),
  });
}

main().catch((e) => {
  console.error('💥 Fatal:', e.message);
  process.exit(1);
});
