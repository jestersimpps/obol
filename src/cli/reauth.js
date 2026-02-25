const { loadConfig } = require('../config');
const { runOAuthFlow } = require('./config');

async function reauth() {
  const cfg = loadConfig({ resolve: false });
  if (!cfg) {
    console.log('\n  No config found. Run "obol init" first.\n');
    return;
  }
  await runOAuthFlow(cfg);
}

module.exports = { reauth };
