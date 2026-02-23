const { loadConfig, OBOL_DIR } = require('./config');
const { createBot } = require('./telegram');
const { createClaude } = require('./claude');
const { createMemory } = require('./memory');
const { createMessageLog } = require('./messages');
const { loadPersonality } = require('./personality');
const { setupBackup } = require('./backup');
const { setupHeartbeat } = require('./heartbeat');

async function main() {
  const config = loadConfig();
  if (!config) {
    console.error('🪙 Not configured. Run: obol init');
    process.exit(1);
  }

  console.log('🪙 OBOL starting...\n');

  // Initialize components
  const personality = loadPersonality();
  const memory = config.supabase ? await createMemory(config.supabase) : null;
  const claude = createClaude(config.anthropic, { personality, memory });
  const messageLog = config.supabase ? createMessageLog(config.supabase, memory, claude.client) : null;
  const bot = createBot(config.telegram, claude, memory, messageLog);

  // Setup heartbeat
  if (config.heartbeat !== false) {
    setupHeartbeat(claude, memory);
  }

  // Setup GitHub backup
  if (config.github) {
    setupBackup(config.github);
  }

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n🪙 ${signal} received. Shutting down gracefully...`);
    bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start bot
  console.log('🪙 OBOL is alive. Listening for messages...\n');
  await bot.start({
    onStart: (info) => console.log(`  Bot: @${info.username}`),
  });
}

main().catch((e) => {
  console.error('💥 Fatal:', e.message);
  process.exit(1);
});
