const cron = require('node-cron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { OBOL_DIR, loadConfig } = require('./config');

function setupBackup(githubConfig) {
  const { listUsers } = require('./config');

  cron.schedule('0 3 * * *', async () => {
    try {
      const users = listUsers();
      for (const userId of users) {
        const userDir = path.join(OBOL_DIR, 'users', userId);
        await runBackup(githubConfig, null, userDir).catch(e =>
          console.error(`[${new Date().toISOString()}] Backup failed for user ${userId}: ${e.message}`)
        );
      }
      console.log(`[${new Date().toISOString()}] Backup complete (${users.length} users)`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Backup failed: ${e.message}`);
    }
  });

  console.log('  ✅ GitHub backup scheduled (daily 3 AM)');
}

async function runBackup(githubConfig, commitMessage, userDir) {
  const { token, username, repo } = githubConfig;
  const baseDir = userDir || OBOL_DIR;
  const backupDir = path.join(baseDir, '.backup-repo');
  const repoUrl = `https://${token}@github.com/${username}/${repo}.git`;
  const botName = loadConfig({ resolve: false })?.bot?.name || 'OBOL';

  if (!fs.existsSync(path.join(backupDir, '.git'))) {
    execSync(`git clone ${repoUrl} "${backupDir}"`, { stdio: 'pipe' });
  } else {
    execSync('git pull', { cwd: backupDir, stdio: 'pipe' });
  }

  execSync(`git config user.name "${botName}"`, { cwd: backupDir });
  execSync('git config user.email "obol@backup"', { cwd: backupDir });

  const syncDirs = ['personality', 'scripts', 'tests', 'commands', 'apps'];
  for (const dir of syncDirs) {
    const src = path.join(baseDir, dir);
    const dst = path.join(backupDir, dir);
    if (fs.existsSync(src)) {
      fs.mkdirSync(dst, { recursive: true });
      fs.cpSync(src, dst, { recursive: true, force: true });
    }
  }

  execSync('git add -A', { cwd: backupDir, stdio: 'pipe' });

  try {
    const status = execSync('git status --porcelain', { cwd: backupDir, encoding: 'utf-8' });
    if (status.trim()) {
      const date = new Date().toISOString().slice(0, 10);
      const msg = commitMessage || `backup: ${date}`;
      const { execFileSync } = require('child_process');
      execFileSync('git', ['commit', '-m', msg], { cwd: backupDir, stdio: 'pipe' });
      execSync('git push', { cwd: backupDir, stdio: 'pipe' });
    }
  } catch (e) {
    console.error('[backup] Commit/push failed:', e.message);
  }
}

module.exports = { setupBackup, runBackup };
