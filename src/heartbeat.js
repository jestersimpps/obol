const cron = require('node-cron');

function setupHeartbeat(claude, memory) {
  // Every 30 minutes, check if anything needs attention
  cron.schedule('*/30 * * * *', async () => {
    console.log(`[${new Date().toISOString()}] Heartbeat tick`);

    // Memory consolidation could go here
    // Email checks could go here
    // Custom heartbeat tasks from AGENTS.md could go here
  });

  console.log('  ✅ Heartbeat running (every 30min)');
}

module.exports = { setupHeartbeat };
