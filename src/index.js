const fs = require('fs');
const path = require('path');
const { loadConfig, OBOL_DIR } = require('./config');
const { createBot } = require('./telegram');
const { setupBackup } = require('./backup');
const { setupHeartbeat } = require('./heartbeat');
const { migrateToMultiTenant } = require('./legacy-migrate');
const { isPostSetupDone, runPostSetup } = require('./post-setup');

const MIGRATION_MARKER = path.join(OBOL_DIR, '.migrated');

async function main() {
  const config = loadConfig();
  if (!config) {
    console.error('🪙 Not configured. Run: obol init');
    process.exit(1);
  }

  console.log('🪙 OBOL starting...\n');

  await migrateToMultiTenant(config);

  if (config.supabase?.url && config.supabase?.serviceKey) {
    if (fs.existsSync(MIGRATION_MARKER)) {
      console.log('  Database already migrated');
    } else {
      try {
        const { migrate } = require('./db/migrate');
        await migrate(config.supabase);
        fs.writeFileSync(MIGRATION_MARKER, new Date().toISOString());
        console.log('  Database ready');
      } catch (e) {
        console.error(`  Database migration failed: ${e.message}`);
      }
    }
  }

  if (!isPostSetupDone()) {
    runPostSetup(loadConfig({ resolve: false }), console.log).catch(e =>
      console.error('Post-setup error:', e.message)
    );
  }

  const bot = createBot(config.telegram, config);

  if (config.heartbeat !== false) {
    setupHeartbeat();
  }

  if (config.github) {
    setupBackup(config.github);
  }

  const shutdown = (signal) => {
    console.log(`\n🪙 ${signal} received. Shutting down gracefully...`);
    bot.stop();
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
