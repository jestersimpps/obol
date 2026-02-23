const inquirer = require('inquirer');
const open = require('open');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getConfigDir, saveConfig, loadConfig, CONFIG_FILE, ensureUserDir } = require('../config');

const OBOL_DIR = getConfigDir();

async function validateCredential(name, validateFn) {
  process.stdout.write(`  Validating ${name}...`);
  try {
    const result = await validateFn();
    console.log(` ✅ ${result}`);
    return true;
  } catch (e) {
    console.log(` ❌ ${e.message}`);
    const { proceed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'proceed',
      message: 'Continue anyway? (you can fix later with obol config)',
      default: true,
    }]);
    return proceed;
  }
}

async function validateAnthropic(apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  if (res.status === 401) throw new Error('Invalid API key');
  if (res.status === 403) throw new Error('Key lacks permissions');
  if (res.status === 400) {
    const body = await res.json();
    if (body.error?.message?.includes('billing')) throw new Error('No credits — add funds at console.anthropic.com');
  }
  if (res.status === 429) throw new Error('Rate limited — key is valid but try again later');
  if (res.status >= 500) throw new Error(`Anthropic server error (${res.status}) — key may be valid, try again`);
  if (!res.ok && res.status !== 200) throw new Error(`Unexpected status: ${res.status}`);
  return 'Key valid';
}

async function validateTelegram(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = await res.json();
  if (!data.ok) throw new Error('Invalid bot token');
  return `Bot: @${data.result.username}`;
}

async function detectTelegramUserId(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=10`);
  const data = await res.json();
  if (!data.ok || !data.result?.length) return null;
  const users = new Map();
  for (const update of data.result) {
    const from = update.message?.from;
    if (from && !from.is_bot) {
      users.set(from.id, from.first_name + (from.username ? ` (@${from.username})` : ''));
    }
  }
  return users.size > 0 ? users : null;
}

async function validateSupabase(url, serviceKey) {
  const res = await fetch(`${url}/rest/v1/`, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    },
  });
  if (res.status === 401 || res.status === 403) throw new Error('Invalid service key');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return 'Connected';
}

async function validateVercel(token) {
  const res = await fetch('https://api.vercel.com/v9/projects', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) throw new Error('Invalid token');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return 'Token valid';
}

function checkNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    console.error(`  ❌ Node.js 18+ required (you have ${process.version})`);
    process.exit(1);
  }
}

async function init(opts = {}) {
  checkNodeVersion();
  console.log('\n🪙 OBOL — Your AI, your rules.\n');

  if (opts.restore) {
    return await restore();
  }

  if (fs.existsSync(CONFIG_FILE) && !opts.reset) {
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'Config already exists. What do you want to do?',
      choices: [
        { name: 'Edit configuration (obol config)', value: 'edit' },
        { name: 'Start fresh (reset everything)', value: 'reset' },
        { name: 'Cancel', value: 'cancel' },
      ],
    }]);
    if (action === 'cancel') return;
    if (action === 'edit') {
      const { config: configCmd } = require('./config');
      return configCmd();
    }
    fs.unlinkSync(CONFIG_FILE);
    console.log('  Config removed. Starting fresh...\n');
  }

  if (opts.reset) {
    if (fs.existsSync(CONFIG_FILE)) {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: 'This will erase your current config. Continue?',
        default: false,
      }]);
      if (!confirm) {
        console.log('  Cancelled.\n');
        return;
      }
      fs.unlinkSync(CONFIG_FILE);
      console.log('  Config removed. Starting fresh...\n');
    }
  }

  // Create directory structure
  ensureDirs();

  const config = {};

  // Step 1: Anthropic
  console.log('─── Step 1/7: Anthropic (AI brain) ───\n');
  console.log('  OBOL uses Claude as its brain. You need an Anthropic API key.\n');
  console.log('  How to get it:');
  console.log('    1. Go to https://console.anthropic.com');
  console.log('    2. Sign up or log in');
  console.log('    3. Go to Settings > API Keys > Create Key');
  console.log('    4. Copy the key (starts with sk-ant-)');
  console.log('    5. Make sure you have credits: Billing > Add funds ($5 min)\n');
  const { anthropicKey } = await inquirer.prompt([{
    type: 'password',
    name: 'anthropicKey',
    message: 'Anthropic API key:',
    mask: '*',
    validate: (v) => v.startsWith('sk-ant-') ? true : 'Should start with sk-ant-',
  }]);
  config.anthropic = { apiKey: anthropicKey };
  await validateCredential('Anthropic', () => validateAnthropic(anthropicKey));
  console.log('');

  // Step 2: Telegram
  console.log('─── Step 2/7: Telegram (chat interface) ───\n');
  console.log('  You talk to OBOL through a Telegram bot. You need to create one.\n');
  console.log('  How to get your bot token:');
  console.log('    1. Open Telegram on your phone or desktop');
  console.log('    2. Search for @BotFather and start a chat');
  console.log('    3. Send /newbot');
  console.log('    4. Pick a display name (e.g. "My OBOL")');
  console.log('    5. Pick a username ending in "bot" (e.g. "my_obol_bot")');
  console.log('    6. BotFather replies with a token like 7123456789:AAF...');
  console.log('    7. Copy that token\n');
  const { telegramToken } = await inquirer.prompt([{
    type: 'password',
    name: 'telegramToken',
    message: 'Telegram bot token:',
    mask: '*',
    validate: (v) => v.includes(':') ? true : 'Should look like 7123456789:AAF... (contains a colon)',
  }]);
  config.telegram = { token: telegramToken };
  await validateCredential('Telegram', () => validateTelegram(telegramToken));
  console.log('');

  // Step 3: Supabase
  console.log('─── Step 3/7: Supabase (memory) ───\n');
  console.log('  Supabase gives your bot persistent vector memory so it can');
  console.log('  remember conversations, facts, and context across restarts.\n');
  console.log('  Sign up free at: https://supabase.com');
  console.log('  You can auto-create a project or use an existing one.\n');
  const { supabaseSetup } = await inquirer.prompt([{
    type: 'list',
    name: 'supabaseSetup',
    message: 'Supabase setup:',
    choices: [
      { name: 'Create new project (auto-setup, needs access token)', value: 'create' },
      { name: 'Use existing project (need project ID + service role key)', value: 'existing' },
      { name: 'Skip (no long-term memory — bot forgets on restart)', value: 'skip' },
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

  if (config.supabase?.url && config.supabase?.serviceKey) {
    await validateCredential('Supabase', () => validateSupabase(config.supabase.url, config.supabase.serviceKey));
    console.log('');
  }

  // Step 4: GitHub
  console.log('─── Step 4/7: GitHub (backup) ───\n');
  const { skipGithub } = await inquirer.prompt([{
    type: 'confirm',
    name: 'skipGithub',
    message: 'Set up GitHub backup?',
    default: true,
  }]);
  if (skipGithub) {
    console.log('  OBOL backs up its personality, scripts, and commands to a');
    console.log('  private GitHub repo daily. This lets you restore on any server.\n');
    console.log('  How to get a token:');
    console.log('    1. Go to https://github.com/settings/tokens');
    console.log('    2. Click "Generate new token (classic)"');
    console.log('    3. Name it "obol"');
    console.log('    4. Check the "repo" scope (full control of private repos)');
    console.log('    5. Click "Generate token" and copy it\n');
    const { githubToken } = await inquirer.prompt([{
      type: 'password',
      name: 'githubToken',
      message: 'GitHub personal access token:',
      mask: '*',
    }]);
    config.github = await setupGitHub(githubToken);
  } else {
    config.github = null;
    console.log('  Skipped — no backup configured\n');
  }

  // Step 5: Vercel
  console.log('─── Step 5/7: Vercel (deploy sites) ───\n');
  const { skipVercel } = await inquirer.prompt([{
    type: 'confirm',
    name: 'skipVercel',
    message: 'Set up Vercel deployments?',
    default: true,
  }]);
  if (skipVercel) {
    console.log('  OBOL can deploy websites and apps to Vercel for you.\n');
    console.log('  How to get a token:');
    console.log('    1. Go to https://vercel.com (sign up free if needed)');
    console.log('    2. Go to https://vercel.com/account/tokens');
    console.log('    3. Click "Create" and name it "obol"');
    console.log('    4. Copy the token\n');
    const { vercelToken } = await inquirer.prompt([{
      type: 'password',
      name: 'vercelToken',
      message: 'Vercel token:',
      mask: '*',
    }]);
    config.vercel = { token: vercelToken };
    await validateCredential('Vercel', () => validateVercel(vercelToken));
  } else {
    config.vercel = null;
    console.log('  Skipped — no deploy target configured\n');
  }
  console.log('');

  // Step 6: Identity
  console.log('─── Step 6/7: Identity ───\n');
  console.log('  Give your bot a name and tell it who you are.\n');
  const { ownerName, botName } = await inquirer.prompt([
    { type: 'input', name: 'ownerName', message: 'Your name:', validate: (v) => v.length > 0 },
    { type: 'input', name: 'botName', message: 'Bot name:', default: 'OBOL' },
  ]);
  config.owner = { name: ownerName };
  config.bot = { name: botName };

  // Step 7: Allowed Telegram users
  console.log('\n─── Step 7/7: Access control ───\n');
  console.log('  Each allowed user gets their own isolated brain — separate');
  console.log('  personality, memory, evolution cycle, and workspace.');
  console.log('  You can add multiple users now or later with `obol config`.\n');

  config.telegram.allowedUsers = await collectAllowedUsers(config.telegram.token);

  if (config.telegram.allowedUsers.length >= 2) {
    const { bridgeEnabled } = await inquirer.prompt([{
      type: 'confirm',
      name: 'bridgeEnabled',
      message: 'Enable bridge between user agents? (lets agents query each other)',
      default: true,
    }]);
    config.bridge = { enabled: bridgeEnabled };
  }

  saveConfig(config);
  console.log(`\n  ✅ Config saved to ${CONFIG_FILE}`);

  for (const userId of config.telegram.allowedUsers) {
    ensureUserDir(userId);
    console.log(`  ✅ Created user directory for ${userId}`);
  }

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
      console.log('  Run the SQL manually in Supabase dashboard.');
    }
  }

  console.log(`
🪙 Done! Setup complete.

  Next steps:
    obol start      Start the bot
    obol start -d   Start as background daemon
    obol config     Edit configuration later
    obol status     Check bot status

  Config: ${CONFIG_FILE}
`);
}

async function collectAllowedUsers(token) {
  const detected = token ? await detectTelegramUserId(token) : null;
  const selected = [];

  if (detected && detected.size > 0) {
    console.log('  Found users who messaged this bot:\n');
    const choices = [...detected.entries()].map(([id, name]) => ({
      name: `${id} — ${name}`,
      value: id,
      checked: true,
    }));
    const { picked } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'picked',
      message: 'Select users to allow:',
      choices,
      validate: () => true,
    }]);
    selected.push(...picked);
  } else {
    console.log('  No messages detected from this bot yet.\n');
    console.log('  How to find your Telegram ID:');
    console.log('    1. Send any message to your bot on Telegram');
    console.log('    2. Re-run `obol init` — it will auto-detect you');
    console.log('    3. Or search @userinfobot on Telegram for your numeric ID\n');
  }

  const { addMore } = await inquirer.prompt([{
    type: 'confirm',
    name: 'addMore',
    message: selected.length > 0
      ? 'Add more users by ID?'
      : 'Enter user IDs manually?',
    default: selected.length === 0,
  }]);

  if (addMore) {
    const { extraIds } = await inquirer.prompt([{
      type: 'input',
      name: 'extraIds',
      message: 'Telegram user ID(s) (comma-separated):',
      validate: (v) => {
        if (!v.trim()) return 'Enter at least one ID';
        return v.split(',').every(id => /^\d+$/.test(id.trim())) ? true : 'Must be numeric IDs (e.g. 206639616)';
      },
    }]);
    const extras = extraIds.split(',').map(id => parseInt(id.trim()));
    for (const id of extras) {
      if (!selected.includes(id)) selected.push(id);
    }
  }

  if (selected.length === 0) {
    console.log('  ⚠️  No users added — nobody can talk to the bot.');
    console.log('  Add users later with `obol config`\n');
    return [];
  }

  console.log(`\n  ✅ ${selected.length} user${selected.length > 1 ? 's' : ''} allowed`);
  for (const id of selected) {
    const name = detected?.get(id);
    console.log(`     ${id}${name ? ` — ${name}` : ''}`);
  }
  console.log('');

  return selected;
}

async function setupSupabaseNew() {
  console.log('\n  An access token lets OBOL create and manage a Supabase project for you.\n');
  console.log('  How to get it:');
  console.log('    1. Go to https://supabase.com/dashboard/account/tokens');
  console.log('    2. Click "Generate new token"');
  console.log('    3. Name it "obol" and copy the token\n');
  const { accessToken } = await inquirer.prompt([{
    type: 'password',
    name: 'accessToken',
    message: 'Supabase access token:',
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
  console.log('\n  You need two things from your Supabase project:\n');
  console.log('  1. Project ID (or full URL)');
  console.log('     - Go to your project dashboard');
  console.log('     - The ID is in the URL: supabase.com/dashboard/project/<THIS PART>');
  console.log('     - Or use the full URL: https://xxx.supabase.co\n');
  console.log('  2. Service role key');
  console.log('     - Go to: Project Settings > Data API (or API)');
  console.log('     - Under "Project API keys", find the "service_role" key');
  console.log('     - It says "This key has the ability to bypass Row Level Security"');
  console.log('     - Click to reveal and copy it\n');
  const { projectRef } = await inquirer.prompt([{
    type: 'input',
    name: 'projectRef',
    message: 'Supabase project URL or project ID:',
    validate: (v) => (v.includes('supabase.co') || /^[a-z0-9]{20}$/.test(v.trim())) ? true : 'Enter https://xxx.supabase.co or a project ID',
  }]);

  const ref = projectRef.trim();
  const url = ref.includes('supabase.co') ? ref.replace(/\/+$/, '') : `https://${ref}.supabase.co`;

  const { serviceKey } = await inquirer.prompt([{
    type: 'password',
    name: 'serviceKey',
    message: 'Service role key:',
    mask: '*',
  }]);

  console.log('  ✅ Supabase configured\n');
  return { url, serviceKey };
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
    execSync(`git clone https://${githubToken}@github.com/${user.login}/${repoName}.git /tmp/obol-restore`, { stdio: 'pipe' });
    console.log('  ✅ Brain downloaded. Will be placed after user ID is configured.\n');
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

  const { allowedUsers } = await inquirer.prompt([{
    type: 'input',
    name: 'allowedUsers',
    message: 'Telegram user ID(s) (comma-separated):',
    validate: (v) => v.split(',').every(id => /^\d+$/.test(id.trim())) ? true : 'Must be numeric IDs',
  }]);
  const userIds = allowedUsers.split(',').map(id => parseInt(id.trim()));

  const existingConfig = loadConfig() || {};
  existingConfig.anthropic = { apiKey: anthropicKey };
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

function ensureDirs() {
  const dirs = ['logs', 'migrations', 'users'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(OBOL_DIR, dir), { recursive: true });
  }
}

function createPersonalityFiles(config) {
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
Drop scripts in your user scripts/ directory — they become available as tools.

## Commands
Drop .md files in your user commands/ directory — they become slash commands.

## Safety
- Don't exfiltrate private data
- Don't run destructive commands without asking
- Draft emails/posts — owner sends them

---
*Edit this file to change how your bot operates.*
`;

  for (const userId of config.telegram.allowedUsers) {
    const personalityDir = path.join(OBOL_DIR, 'users', String(userId), 'personality');
    fs.mkdirSync(personalityDir, { recursive: true });

    if (!fs.existsSync(path.join(personalityDir, 'SOUL.md'))) {
      fs.writeFileSync(path.join(personalityDir, 'SOUL.md'), soul);
    }
    if (!fs.existsSync(path.join(personalityDir, 'USER.md'))) {
      fs.writeFileSync(path.join(personalityDir, 'USER.md'), user);
    }
    if (!fs.existsSync(path.join(personalityDir, 'AGENTS.md'))) {
      fs.writeFileSync(path.join(personalityDir, 'AGENTS.md'), agents);
    }
  }

  console.log('  ✅ Personality files created for each user');
}

module.exports = { init };
