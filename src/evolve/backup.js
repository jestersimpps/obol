async function backupSnapshot(message, userDir) {
  try {
    const { loadConfig } = require('../config');
    const cfg = loadConfig();
    if (cfg?.github) {
      const { runBackup } = require('../backup');
      await runBackup(cfg.github, message, userDir);
    }
  } catch {}
}

module.exports = { backupSnapshot };
