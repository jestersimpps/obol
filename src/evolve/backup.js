async function backupSnapshot(message, userDir) {
  try {
    const { loadConfig } = require('../config');
    const cfg = loadConfig({ resolve: false });
    if (!cfg?.github?.token || !cfg?.github?.username || !cfg?.github?.repo) return;
    const resolved = loadConfig();
    const { runBackup } = require('../backup');
    await runBackup(resolved.github, message, userDir);
  } catch {}
}

module.exports = { backupSnapshot };
