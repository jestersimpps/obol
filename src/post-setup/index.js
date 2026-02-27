const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('../config');
const securityTasks = require('./security');
const systemTasks = require('./system');

const SETUP_TASKS = [...systemTasks, ...securityTasks];

function isPostSetupDone(dir) {
  const flag = path.join(dir || OBOL_DIR, '.post-setup-complete');
  return fs.existsSync(flag);
}

function markPostSetupDone(dir) {
  const flag = path.join(dir || OBOL_DIR, '.post-setup-complete');
  fs.writeFileSync(flag, JSON.stringify({
    completedAt: new Date().toISOString(),
    tasks: SETUP_TASKS.map(t => t.name),
  }));
}

async function runPostSetup(config, reportFn, dir) {
  if (isPostSetupDone(dir)) return;

  if (process.platform !== 'linux') {
    reportFn?.(`⚠️  Post-setup tasks are designed for Linux VPS servers. Skipping on ${process.platform}.`);
    markPostSetupDone(dir);
    return [];
  }

  reportFn?.('🪙 Running post-setup tasks...\n');

  const results = [];
  for (const task of SETUP_TASKS) {
    reportFn?.(`⚙️ ${task.description}...`);
    const result = await task.run(config);
    results.push({ name: task.name, ...result });
    reportFn?.(`  ${result.success ? '✅' : '⚠️'} ${result.message}`);
  }

  markPostSetupDone(dir);

  const summary = results.map(r => `${r.success ? '✅' : '⚠️'} ${r.name}: ${r.message}`).join('\n');
  reportFn?.(`\n🪙 Post-setup complete!\n${summary}`);

  return results;
}

module.exports = { isPostSetupDone, runPostSetup, SETUP_TASKS };
