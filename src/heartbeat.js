const cron = require('node-cron');

function setupHeartbeat() {
  cron.schedule('*/30 * * * *', async () => {
    console.log(`[${new Date().toISOString()}] Heartbeat tick`);
  });

  console.log('  ✅ Heartbeat running (every 30min)');
}

module.exports = { setupHeartbeat };
