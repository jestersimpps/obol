const cron = require('node-cron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { OBOL_DIR } = require('./config');

function setupBackup(githubConfig) {
  const { token, username, repo } = githubConfig;
  const backupDir = path.join(OBOL_DIR, '.backup-repo');

  // Daily backup at 3 AM
  cron.schedule('0 3 * * *', async () => {
    try {
      await runBackup(githubConfig);
      console.log(`[${new Date().toISOString()}] Backup complete`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Backup failed: ${e.message}`);
    }
  });

  console.log('  ✅ GitHub backup scheduled (daily 3 AM)');
}

async function runBackup(githubConfig) {
  const { token, username, repo } = githubConfig;
  const backupDir = path.join(OBOL_DIR, '.backup-repo');
  const repoUrl = `https://${token}@github.com/${username}/${repo}.git`;

  // Clone or pull
  if (!fs.existsSync(path.join(backupDir, '.git'))) {
    execSync(`git clone ${repoUrl} ${backupDir}`, { stdio: 'pipe' });
  } else {
    execSync('git pull', { cwd: backupDir, stdio: 'pipe' });
  }

  // Set git identity
  execSync('git config user.name "OBOL"', { cwd: backupDir });
  execSync('git config user.email "obol@backup"', { cwd: backupDir });

  // Sync files (exclude secrets)
  const syncDirs = ['personality', 'scripts', 'commands'];
  for (const dir of syncDirs) {
    const src = path.join(OBOL_DIR, dir);
    const dst = path.join(backupDir, dir);
    if (fs.existsSync(src)) {
      execSync(`mkdir -p ${dst} && cp -r ${src}/* ${dst}/ 2>/dev/null || true`, { stdio: 'pipe' });
    }
  }

  // Commit and push
  execSync('git add -A', { cwd: backupDir, stdio: 'pipe' });

  try {
    const status = execSync('git status --porcelain', { cwd: backupDir, encoding: 'utf-8' });
    if (status.trim()) {
      const date = new Date().toISOString().slice(0, 10);
      execSync(`git commit -m "backup: ${date}"`, { cwd: backupDir, stdio: 'pipe' });
      execSync('git push', { cwd: backupDir, stdio: 'pipe' });
    }
  } catch {
    // Nothing to commit
  }
}

module.exports = { setupBackup, runBackup };
