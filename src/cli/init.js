const inquirer = require('inquirer');
const open = require('open');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getConfigDir, saveConfig, loadConfig, CONFIG_FILE, ensureUserDir } = require('../config');
const { generatePKCE, buildAuthorizationUrl, exchangeCodeForTokens } = require('../oauth');
const {
  validateAnthropic, validateTelegram, validateSupabase,
} = require('../validators');

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

function checkNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    console.error(`  ❌ Node.js 18+ required (you have ${process.version})`);
    process.exit(1);
  }
}

async function promptApiKey() {
  console.log('\n  How to get it:');
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
  return anthropicKey;
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
  const initFlag = path.join(OBOL_DIR, '.init-in-progress');
  fs.writeFileSync(initFlag, new Date().toISOString());

  const config = {};
  let step = 0;
  const totalSteps = 5;
  const stepLabel = (name) => `─── Step ${++step}/${totalSteps}: ${name} ───`;

  // Step 1: Anthropic
  console.log(stepLabel('Anthropic (AI brain)') + '\n');
  console.log('  OBOL uses Claude as its brain. Choose how to connect:\n');
  const { authMethod } = await inquirer.prompt([{
    type: 'list',
    name: 'authMethod',
    message: 'Authentication method:',
    choices: [
      { name: 'API Key (usage-based billing from console.anthropic.com)', value: 'apikey' },
      { name: 'Claude Max OAuth (use your Pro/Max subscription)', value: 'oauth' },
    ],
  }]);

  if (authMethod === 'oauth') {
    config.anthropic = await setupAnthropicOAuth();

    const { addApiKey } = await inquirer.prompt([{
      type: 'confirm',
      name: 'addApiKey',
      message: 'Also add an API key as fallback? (used if OAuth token refresh fails)',
      default: false,
    }]);
    if (addApiKey) {
      const apiKey = await promptApiKey();
      await validateCredential('Anthropic API key', () => validateAnthropic(apiKey));
      config.anthropic.apiKey = apiKey;
    }
  } else {
    const apiKey = await promptApiKey();
    config.anthropic = { apiKey };
    await validateCredential('Anthropic', () => validateAnthropic(apiKey));

    const { addOAuth } = await inquirer.prompt([{
      type: 'confirm',
      name: 'addOAuth',
      message: 'Also set up Claude Max OAuth? (uses your Pro/Max subscription)',
      default: false,
    }]);
    if (addOAuth) {
      const oauthResult = await setupAnthropicOAuth();
      if (oauthResult.oauth) {
        config.anthropic.oauth = oauthResult.oauth;
      }
    }
  }
  console.log('');

  // Step 2: Telegram
  console.log(stepLabel('Telegram (chat interface)') + '\n');
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
  console.log(stepLabel('Supabase (memory)') + '\n');
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

  // Step 4: Identity
  console.log(stepLabel('Identity') + '\n');
  console.log('  Give your bot a name and tell it who you are.');
  console.log('  The bot name appears in personality files. Change later with `obol config`.\n');
  const { ownerName, botName } = await inquirer.prompt([
    { type: 'input', name: 'ownerName', message: 'Your name:', validate: (v) => v.length > 0 },
    { type: 'input', name: 'botName', message: 'Bot name:', default: 'OBOL' },
  ]);
  config.owner = { name: ownerName };
  config.bot = { name: botName };

  // Step 5: Allowed Telegram users
  console.log('\n' + stepLabel('Access control') + '\n');
  console.log('  Each allowed user gets their own isolated brain — separate');
  console.log('  personality, memory, evolution cycle, and workspace.');
  console.log('  You can add multiple users now or later with `obol config`.\n');

  config.telegram.allowedUsers = await collectAllowedUsers(config.telegram.token);

  if (config.telegram.allowedUsers.length >= 2) {
    console.log('  Since you have multiple users, name each one:\n');
    config.users = {};
    for (const userId of config.telegram.allowedUsers) {
      const { userName } = await inquirer.prompt([{
        type: 'input',
        name: 'userName',
        message: `Name for user ${userId}:`,
        default: config.owner.name,
        validate: (v) => v.length > 0,
      }]);
      config.users[String(userId)] = { name: userName };
    }

    const { bridgeEnabled } = await inquirer.prompt([{
      type: 'confirm',
      name: 'bridgeEnabled',
      message: 'Enable bridge between user agents? (lets agents query each other)',
      default: true,
    }]);
    config.bridge = { enabled: bridgeEnabled };
  }

  saveConfig(config);
  try { fs.unlinkSync(initFlag); } catch {}
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
      const markerPath = path.join(OBOL_DIR, '.migrated');
      fs.writeFileSync(markerPath, new Date().toISOString());
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
    obol upgrade    Update to latest version

  Config: ${CONFIG_FILE}
`);
}

async function setupAnthropicOAuth() {
  console.log('\n  This will open your browser to sign in with your Anthropic account.\n');

  const { verifier, challenge } = await generatePKCE();
  const authUrl = buildAuthorizationUrl(challenge, verifier);

  console.log('  Opening browser...\n');
  try {
    await open(authUrl);
  } catch {
    console.log('  Could not open browser automatically.');
  }
  console.log(`  If the browser didn't open, go to:\n  ${authUrl}\n`);
  console.log('  After signing in, you\'ll see a page with a code.');
  console.log('  The URL will look like: ...callback?code=XXXXX#STATE\n');

  const { callbackInput } = await inquirer.prompt([{
    type: 'input',
    name: 'callbackInput',
    message: 'Paste the full callback URL or just the code:',
    validate: (v) => v.trim().length > 0 ? true : 'Required',
  }]);

  const input = callbackInput.trim();

  if (input.includes('sk-ant-oat')) {
    console.log('  That\'s a raw token, not a callback URL.');
    console.log('  Paste the full URL from your browser after authorizing.\n');
    return await setupAnthropicOAuth();
  }

  let code, state;

  if (input.includes('code=')) {
    const url = new URL(input);
    code = url.searchParams.get('code');
    state = url.hash?.replace('#', '') || verifier;
  } else if (input.includes('#')) {
    [code, state] = input.split('#');
  } else {
    code = input;
    state = verifier;
  }

  process.stdout.write('  Exchanging code for tokens...');
  try {
    const tokens = await exchangeCodeForTokens(code, state, verifier);
    console.log(' ✅ Authenticated');
    console.log(`  Access token expires: ${new Date(tokens.expires).toLocaleString()}\n`);
    return {
      oauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expires: tokens.expires,
      },
    };
  } catch (e) {
    console.log(` ❌ ${e.message}`);
    console.log('\n  Falling back to API key...\n');
    const { anthropicKey } = await inquirer.prompt([{
      type: 'password',
      name: 'anthropicKey',
      message: 'Anthropic API key:',
      mask: '*',
      validate: (v) => v.startsWith('sk-ant-') ? true : 'Should start with sk-ant-',
    }]);
    await validateCredential('Anthropic', () => validateAnthropic(anthropicKey));
    return { apiKey: anthropicKey };
  }
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
    console.log('  ⚠️  No messages detected from this bot yet.\n');
    console.log('  To auto-detect your ID:');
    console.log('    1. Open Telegram and send ANY message to your bot');
    console.log('    2. Come back here and re-run `obol init`\n');
    console.log('  Or enter your ID manually:');
    console.log('    1. Open Telegram and search for @raw_data_bot');
    console.log('    2. Send /start — it replies with your numeric ID');
    console.log('    3. Enter it below\n');
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
        const ids = v.split(',').map(id => id.trim());
        for (const id of ids) {
          if (!/^\d+$/.test(id)) return `"${id}" is not a valid numeric ID`;
          if (id.length > 15) return `"${id}" is too long — Telegram IDs are typically 9-10 digits`;
        }
        return true;
      },
    }]);
    const extras = extraIds.split(',').map(id => parseInt(id.trim()));
    for (const id of extras) {
      if (!selected.includes(id)) selected.push(id);
    }
  }

  if (selected.length === 0) {
    console.log('');
    console.log('  ⚠️  WARNING: No users added — your bot will reject ALL messages.');
    console.log('  It will not respond to anyone until you add users.\n');
    const { continueEmpty } = await inquirer.prompt([{
      type: 'confirm',
      name: 'continueEmpty',
      message: 'Continue without any users? (you can add them later with `obol config`)',
      default: false,
    }]);
    if (!continueEmpty) {
      return await collectAllowedUsers(token);
    }
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

  const { region } = await inquirer.prompt([{
    type: 'list',
    name: 'region',
    message: 'Supabase region (pick closest to your server):',
    choices: [
      { name: 'US East (Virginia)', value: 'us-east-1' },
      { name: 'US West (Oregon)', value: 'us-west-1' },
      { name: 'EU Central (Frankfurt)', value: 'eu-central-1' },
      { name: 'EU West (London)', value: 'eu-west-2' },
      { name: 'AP Southeast (Singapore)', value: 'ap-southeast-1' },
      { name: 'AP Northeast (Tokyo)', value: 'ap-northeast-1' },
      { name: 'AP South (Mumbai)', value: 'ap-south-1' },
      { name: 'SA East (Sao Paulo)', value: 'sa-east-1' },
    ],
  }]);

  console.log('  Creating project...');
  try {
    const dbPass = require('crypto').randomBytes(16).toString('hex');

    const res = await fetch('https://api.supabase.com/v1/projects', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'obol',
        region,
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
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const remaining = Math.ceil((maxWait - (Date.now() - start)) / 1000);
    process.stdout.write(`\r  Waiting... ${elapsed}s elapsed, ~${remaining}s remaining`);
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const project = await res.json();
    if (project.status === 'ACTIVE_HEALTHY') {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      return;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  process.stdout.write('\n');
  throw new Error('Project creation timed out');
}

async function setupSupabaseExisting() {
  console.log('\n  You need three things from your Supabase project:\n');
  console.log('  1. Project ID (or full URL)');
  console.log('     - Go to your project dashboard');
  console.log('     - The ID is in the URL: supabase.com/dashboard/project/<THIS PART>');
  console.log('     - Or use the full URL: https://xxx.supabase.co\n');
  console.log('  2. Service role key');
  console.log('     - Go to: Project Settings > Data API (or API)');
  console.log('     - Under "Project API keys", find the "service_role" key');
  console.log('     - It says "This key has the ability to bypass Row Level Security"');
  console.log('     - Click to reveal and copy it\n');
  console.log('  3. Access token (needed to run database migrations)');
  console.log('     - Go to: https://supabase.com/dashboard/account/tokens');
  console.log('     - Click "Generate new token", name it "obol"');
  console.log('     - Copy the token\n');
  const { projectRef } = await inquirer.prompt([{
    type: 'input',
    name: 'projectRef',
    message: 'Supabase project URL or project ID:',
    validate: (v) => (v.includes('supabase.co') || /^[a-z]{20,}$/.test(v.trim())) ? true : 'Enter https://xxx.supabase.co or a project ID (lowercase letters, 20+ chars)',
  }]);

  const ref = projectRef.trim();
  const url = ref.includes('supabase.co') ? ref.replace(/\/+$/, '') : `https://${ref}.supabase.co`;

  const { serviceKey } = await inquirer.prompt([{
    type: 'password',
    name: 'serviceKey',
    message: 'Service role key:',
    mask: '*',
  }]);

  const { accessToken } = await inquirer.prompt([{
    type: 'password',
    name: 'accessToken',
    message: 'Supabase access token:',
    mask: '*',
  }]);

  console.log('  ✅ Supabase configured\n');
  return { url, serviceKey, accessToken };
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

function ensureDirs() {
  const dirs = ['logs', 'migrations', 'users'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(OBOL_DIR, dir), { recursive: true });
  }
}

function createPersonalityFiles(config) {
  const { PERSONALITY_DIR } = require('../soul');
  fs.mkdirSync(PERSONALITY_DIR, { recursive: true });
  const ownerName = config.users?.[String(config.telegram.allowedUsers[0])]?.name || config.owner.name;

  if (!fs.existsSync(path.join(PERSONALITY_DIR, 'SOUL.md'))) {
    fs.writeFileSync(path.join(PERSONALITY_DIR, 'SOUL.md'), `# SOUL.md — Who is ${config.bot.name}?

Write your bot's personality here. This shapes how it talks, thinks, and behaves.

## Basics
- **Name:** ${config.bot.name}
- **Created by:** ${ownerName}
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
`);
  }

  for (const userId of config.telegram.allowedUsers) {
    const ownerName = config.users?.[String(userId)]?.name || config.owner.name;
    const personalityDir = path.join(OBOL_DIR, 'users', String(userId), 'personality');
    fs.mkdirSync(personalityDir, { recursive: true });

    if (!fs.existsSync(path.join(personalityDir, 'USER.md'))) {
      fs.writeFileSync(path.join(personalityDir, 'USER.md'), `# USER.md — About ${ownerName}

- **Name:** ${ownerName}
- **Telegram ID:** ${userId}

---
*Add more context about yourself so your bot can be more helpful.*
`);
    }
    if (!fs.existsSync(path.join(personalityDir, 'AGENTS.md'))) {
      fs.writeFileSync(path.join(personalityDir, 'AGENTS.md'), `# AGENTS.md — How ${config.bot.name} Works

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
`);
    }
  }

  console.log('  ✅ Personality files created (SOUL.md, USER.md, AGENTS.md) for each user');
}

module.exports = { init };
