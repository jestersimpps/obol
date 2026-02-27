const inquirer = require('inquirer');
const { execSync } = require('child_process');
const { ensureUserDir, loadConfig, saveConfig } = require('../config');
const { setupAnthropicOAuth } = require('./oauth');
const { promptApiKey, validateCredential, ensureDirs } = require('./init-utils');
const { validateAnthropic } = require('../auth/validators');

async function setupGitHub(githubToken) {
  const userRes = await fetch('https://api.github.com/user', {
    headers: { 'Authorization': `token ${githubToken}` },
  });
  const user = await userRes.json();

  if (!user.login) {
    console.log('  ❌ Invalid token');
    return null;
  }

  const scopes = userRes.headers.get('x-oauth-scopes') || '';
  if (!scopes.includes('repo')) {
    console.log('  ⚠️ Token lacks "repo" scope — backup will fail.');
    console.log('  Generate a new token with the "repo" scope checked.');
  }

  const repoName = 'obol-brain';
  console.log(`  Creating private repo: ${user.login}/${repoName}...`);

  try {
    const repoRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `token ${githubToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: repoName,
        private: true,
        description: '🪙 OBOL brain backup — personality, scripts, memory',
        auto_init: true,
      }),
    });

    if (repoRes.status === 422) {
      console.log(`  Repo already exists — will use ${user.login}/${repoName}`);
    } else if (!repoRes.ok) {
      throw new Error(`HTTP ${repoRes.status}`);
    } else {
      console.log(`  ✅ Created github.com/${user.login}/${repoName} (private)`);
    }
  } catch (e) {
    console.log(`  ⚠️  Repo creation failed: ${e.message} — you can create it manually`);
  }

  console.log('  ✅ GitHub backup configured\n');
  return { token: githubToken, username: user.login, repo: repoName };
}

async function restore() {
  console.log('─── Restore from GitHub ───\n');

  const { githubToken } = await inquirer.prompt([{
    type: 'password',
    name: 'githubToken',
    message: 'GitHub token:',
    mask: '*',
  }]);

  const userRes = await fetch('https://api.github.com/user', {
    headers: { 'Authorization': `token ${githubToken}` },
  });
  const user = await userRes.json();
  const repoName = 'obol-brain';

  console.log(`  Cloning ${user.login}/${repoName}...`);

  ensureDirs();
  try {
    execSync(`git clone https://github.com/${user.login}/${repoName}.git /tmp/obol-restore`, {
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_ASKPASS: 'echo',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.https://${githubToken}@github.com/.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/',
      },
    });
    console.log('  ✅ Brain downloaded. Will be placed after user ID is configured.\n');
  } catch (e) {
    console.error(`  ❌ Restore failed: ${e.message}`);
  }

  console.log('  Now set up credentials:\n');
  const { authMethod } = await inquirer.prompt([{
    type: 'list',
    name: 'authMethod',
    message: 'Authentication method:',
    choices: [
      { name: 'API Key', value: 'apikey' },
      { name: 'Claude Max OAuth', value: 'oauth' },
      { name: 'Both (OAuth primary, API key fallback)', value: 'both' },
    ],
  }]);

  let anthropicConfig = {};
  if (authMethod === 'oauth' || authMethod === 'both') {
    const oauthResult = await setupAnthropicOAuth();
    anthropicConfig = oauthResult;
  }
  if (authMethod === 'apikey' || authMethod === 'both') {
    const apiKey = await promptApiKey();
    anthropicConfig.apiKey = apiKey;
  }

  const { telegramToken } = await inquirer.prompt([{
    type: 'password', name: 'telegramToken', message: 'Telegram bot token:', mask: '*',
  }]);

  const { allowedUsers } = await inquirer.prompt([{
    type: 'input',
    name: 'allowedUsers',
    message: 'Telegram user ID(s) (comma-separated):',
    validate: (v) => v.split(',').every(id => /^\d+$/.test(id.trim())) ? true : 'Must be numeric IDs',
  }]);
  const userIds = allowedUsers.split(',').map(id => parseInt(id.trim()));

  const existingConfig = loadConfig() || {};
  existingConfig.anthropic = anthropicConfig;
  existingConfig.telegram = { ...existingConfig.telegram, token: telegramToken, allowedUsers: userIds };
  existingConfig.github = { token: githubToken, username: user.login, repo: repoName };
  saveConfig(existingConfig);

  for (const userId of userIds) {
    const userDir = ensureUserDir(userId);
    try {
      execSync(`cp -r /tmp/obol-restore/personality/* "${userDir}/personality/" 2>/dev/null || true`);
      execSync(`cp -r /tmp/obol-restore/scripts/* "${userDir}/scripts/" 2>/dev/null || true`);
      execSync(`cp -r /tmp/obol-restore/commands/* "${userDir}/commands/" 2>/dev/null || true`);
      console.log(`  ✅ Brain restored for user ${userId}`);
    } catch {}
  }
  execSync('rm -rf /tmp/obol-restore');

  console.log('\n🪙 Restored! Run: obol start\n');
}

module.exports = { setupGitHub, restore };
