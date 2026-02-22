const inquirer = require('inquirer');
const open = require('open');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getConfigDir, saveConfig, loadConfig, CONFIG_FILE } = require('../config');

const OBOL_DIR = getConfigDir();

async function init(opts = {}) {
  console.log('\n🪙 OBOL — Your AI, your rules.\n');

  // Check for restore mode
  if (opts.restore) {
    return await restore();
  }

  // Create directory structure
  ensureDirs();

  const config = {};

  // Step 1: Anthropic
  console.log('─── Anthropic ───');
  const { anthropicKey } = await inquirer.prompt([{
    type: 'password',
    name: 'anthropicKey',
    message: 'Paste your Anthropic API key:',
    mask: '*',
    validate: (v) => v.startsWith('sk-ant-') ? true : 'Should start with sk-ant-',
  }]);
  config.anthropic = { apiKey: anthropicKey };
  console.log('  ✅ Anthropic configured\n');

  // Step 2: Telegram
  console.log('─── Telegram ───');
  console.log('  Create a bot via @BotFather on Telegram, then paste the token.\n');
  const { telegramToken } = await inquirer.prompt([{
    type: 'password',
    name: 'telegramToken',
    message: 'Paste BotFather token:',
    mask: '*',
    validate: (v) => v.includes(':') ? true : 'Invalid token format',
  }]);
  config.telegram = { token: telegramToken };
  console.log('  ✅ Telegram configured\n');

  // Step 3: Supabase
  console.log('─── Memory (Supabase) ───');
  const { supabaseSetup } = await inquirer.prompt([{
    type: 'list',
    name: 'supabaseSetup',
    message: 'Supabase setup:',
    choices: [
      { name: 'Create new project (requires access token)', value: 'create' },
      { name: 'Use existing project (paste URL + key)', value: 'existing' },
      { name: 'Skip (no long-term memory)', value: 'skip' },
    ],
  }]);

  if (supabaseSetup === 'create') {
    config.supabase = await setupSupabaseNew();
  } else if (supabaseSetup === 'existing') {
    config.supabase = await setupSupabaseExisting();
  } else {
    config.supabase = null;
    console.log('  ⚠️  No memory configured — bot will forget between restarts\n');
  }

  // Step 4: GitHub
  console.log('─── GitHub (backup + repos) ───');
  const { githubToken } = await inquirer.prompt([{
    type: 'password',
    name: 'githubToken',
    message: 'GitHub personal access token (repo scope):',
    mask: '*',
  }]);
  config.github = await setupGitHub(githubToken);

  // Step 4b: Vercel
  console.log('─── Vercel (deploy sites) ───');
  const { vercelToken } = await inquirer.prompt([{
    type: 'password',
    name: 'vercelToken',
    message: 'Vercel token (from vercel.com/account/tokens):',
    mask: '*',
  }]);
  config.vercel = { token: vercelToken };
  console.log('  ✅ Vercel configured\n');

  // Step 5: Identity
  console.log('─── Identity ───');
  const { ownerName, botName } = await inquirer.prompt([
    { type: 'input', name: 'ownerName', message: 'Your name:', validate: (v) => v.length > 0 },
    { type: 'input', name: 'botName', message: 'Bot name:', default: 'OBOL' },
  ]);
  config.owner = { name: ownerName };
  config.bot = { name: botName };

  // Step 6: Allowed Telegram users
  const { allowedUsers } = await inquirer.prompt([{
    type: 'input',
    name: 'allowedUsers',
    message: 'Your Telegram user ID (or comma-separated IDs):',
    validate: (v) => v.split(',').every(id => /^\d+$/.test(id.trim())) ? true : 'Must be numeric IDs',
  }]);
  config.telegram.allowedUsers = allowedUsers.split(',').map(id => parseInt(id.trim()));

  // Save config
  saveConfig(config);
  console.log(`\n  ✅ Config saved to ${CONFIG_FILE}`);

  // Create personality files
  createPersonalityFiles(config);

  // Run Supabase migrations
  if (config.supabase) {
    console.log('\n  Running database migrations...');
    try {
      const { migrate } = require('../db/migrate');
      await migrate(config.supabase);
      console.log('  ✅ Database ready');
    } catch (e) {
      console.error(`  ❌ Migration failed: ${e.message}`);
      console.log('  Run "obol migrate" to retry later.');
    }
  }

  console.log(`\n🪙 Done! Run: obol start\n`);
}

async function setupSupabaseNew() {
  const { accessToken } = await inquirer.prompt([{
    type: 'password',
    name: 'accessToken',
    message: 'Supabase access token (from supabase.com/dashboard/account/tokens):',
    mask: '*',
  }]);

  console.log('  Creating project...');
  try {
    // Generate a random password for the DB
    const dbPass = require('crypto').randomBytes(16).toString('hex');

    const res = await fetch('https://api.supabase.com/v1/projects', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'obol',
        region: 'eu-central-1',
        plan: 'free',
        db_pass: dbPass,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    const project = await res.json();
    console.log(`  ✅ Project created: ${project.id}`);

    // Wait for project to be ready
    console.log('  Waiting for project to initialize (this takes ~60s)...');
    await waitForProject(accessToken, project.id);

    // Get API keys
    const keysRes = await fetch(`https://api.supabase.com/v1/projects/${project.id}/api-keys`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const keys = await keysRes.json();
    const serviceKey = keys.find(k => k.name === 'service_role')?.api_key;
    const anonKey = keys.find(k => k.name === 'anon')?.api_key;
    const url = `https://${project.id}.supabase.co`;

    console.log(`  ✅ Project ready: ${url}\n`);

    return { url, serviceKey, anonKey, accessToken };
  } catch (e) {
    console.error(`  ❌ Failed: ${e.message}`);
    console.log('  Falling back to manual setup...\n');
    return await setupSupabaseExisting();
  }
}

async function waitForProject(token, projectId, maxWait = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const project = await res.json();
    if (project.status === 'ACTIVE_HEALTHY') return;
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Project creation timed out');
}

async function setupSupabaseExisting() {
  const answers = await inquirer.prompt([
    { type: 'input', name: 'url', message: 'Supabase project URL:', validate: (v) => v.includes('supabase.co') ? true : 'Should be https://xxx.supabase.co' },
    { type: 'password', name: 'serviceKey', message: 'Service role key:', mask: '*' },
  ]);
  console.log('  ✅ Supabase configured\n');
  return answers;
}

async function setupGitHub(githubToken) {
  // Get username
  const userRes = await fetch('https://api.github.com/user', {
    headers: { 'Authorization': `token ${githubToken}` },
  });
  const user = await userRes.json();

  if (!user.login) {
    console.log('  ❌ Invalid token');
    return null;
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
    execSync(`git clone https://${githubToken}@github.com/${user.login}/${repoName}.git /tmp/obol-restore`, { stdio: 'pipe' });
    // Copy files
    execSync(`cp -r /tmp/obol-restore/personality/* ${OBOL_DIR}/personality/ 2>/dev/null || true`);
    execSync(`cp -r /tmp/obol-restore/scripts/* ${OBOL_DIR}/scripts/ 2>/dev/null || true`);
    execSync(`cp -r /tmp/obol-restore/commands/* ${OBOL_DIR}/commands/ 2>/dev/null || true`);
    execSync(`rm -rf /tmp/obol-restore`);
    console.log('  ✅ Brain restored\n');
  } catch (e) {
    console.error(`  ❌ Restore failed: ${e.message}`);
  }

  // Still need credentials
  console.log('  Now set up credentials:\n');
  const { anthropicKey } = await inquirer.prompt([{
    type: 'password', name: 'anthropicKey', message: 'Anthropic API key:', mask: '*',
  }]);
  const { telegramToken } = await inquirer.prompt([{
    type: 'password', name: 'telegramToken', message: 'Telegram bot token:', mask: '*',
  }]);

  const existingConfig = loadConfig() || {};
  existingConfig.anthropic = { apiKey: anthropicKey };
  existingConfig.telegram = { ...existingConfig.telegram, token: telegramToken };
  existingConfig.github = { token: githubToken, username: user.login, repo: repoName };
  saveConfig(existingConfig);

  console.log('\n🪙 Restored! Run: obol start\n');
}

function ensureDirs() {
  const dirs = ['personality', 'scripts', 'commands', 'memory/daily', 'logs'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(OBOL_DIR, dir), { recursive: true });
  }
}

function createPersonalityFiles(config) {
  const personalityDir = path.join(OBOL_DIR, 'personality');

  const soul = `# SOUL.md — Who is ${config.bot.name}?

Write your bot's personality here. This shapes how it talks, thinks, and behaves.

## Basics
- **Name:** ${config.bot.name}
- **Created by:** ${config.owner.name}
- **Vibe:** Helpful, direct, gets things done

## Personality
- Direct and concise
- Dark humor welcome
- Actions over words — do first, explain after
- Write things down — memory doesn't survive restarts without it

## Values
- Privacy is sacred — never share owner's data
- Competence builds trust
- Quality over quantity

---
*Edit this file anytime to reshape your bot's personality.*
`;

  const user = `# USER.md — About ${config.owner.name}

- **Name:** ${config.owner.name}
- **Telegram ID:** ${config.telegram.allowedUsers.join(', ')}

---
*Add more context about yourself so your bot can be more helpful.*
`;

  const agents = `# AGENTS.md — How ${config.bot.name} Works

## Memory
Vector memory via Supabase pgvector. Local embeddings (all-MiniLM-L6-v2).

## Scripts
Drop scripts in ~/.obol/scripts/ — they become available as tools.

## Commands
Drop .md files in ~/.obol/commands/ — they become slash commands.

## Safety
- Don't exfiltrate private data
- Don't run destructive commands without asking
- Draft emails/posts — owner sends them

---
*Edit this file to change how your bot operates.*
`;

  if (!fs.existsSync(path.join(personalityDir, 'SOUL.md'))) {
    fs.writeFileSync(path.join(personalityDir, 'SOUL.md'), soul);
  }
  if (!fs.existsSync(path.join(personalityDir, 'USER.md'))) {
    fs.writeFileSync(path.join(personalityDir, 'USER.md'), user);
  }
  if (!fs.existsSync(path.join(personalityDir, 'AGENTS.md'))) {
    fs.writeFileSync(path.join(personalityDir, 'AGENTS.md'), agents);
  }
  console.log('  ✅ Personality files created in ~/.obol/personality/');
}

module.exports = { init };
