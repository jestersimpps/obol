const { execSync } = require('child_process');
const pkg = require('../../package.json');

/** @returns {string|null} */
function getLatestVersion() {
  try {
    return execSync(`npm view ${pkg.name} version`, { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/** @returns {boolean} */
function isBotRunning() {
  try {
    const list = execSync('pm2 jlist', { encoding: 'utf-8' });
    const procs = JSON.parse(list);
    const obol = procs.find(p => p.name === 'obol');
    return obol?.pm2_env?.status === 'online';
  } catch {
    return false;
  }
}

async function upgrade() {
  const current = pkg.version;
  console.log(`🪙 Current version: ${current}`);

  const latest = getLatestVersion();
  if (!latest) {
    console.error('  ❌ Could not reach npm registry');
    process.exit(1);
  }

  if (current === latest) {
    console.log(`  ✅ Already on latest (${latest})`);
    return;
  }

  console.log(`  ⬆ New version available: ${latest}\n`);

  const wasRunning = isBotRunning();

  if (wasRunning) {
    console.log('  Stopping bot...');
    try {
      execSync('pm2 stop obol', { stdio: 'pipe' });
    } catch {}
  }

  console.log('  Installing update...');
  try {
    execSync(`npm install -g ${pkg.name}@latest`, { stdio: 'inherit' });
  } catch (e) {
    console.error(`\n  ❌ Update failed: ${e.message}`);
    if (wasRunning) {
      console.log('  Restarting bot...');
      execSync('pm2 start obol', { stdio: 'pipe' });
    }
    process.exit(1);
  }

  if (wasRunning) {
    console.log('\n  Restarting bot...');
    execSync('pm2 start obol', { stdio: 'pipe' });
  }

  console.log(`\n🪙 Upgraded to ${latest}`);

  const { getLatestChanges } = require('./changelog');
  const changes = getLatestChanges();
  if (changes) console.log(`\n${changes}`);
}

module.exports = { upgrade };
