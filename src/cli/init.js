const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const { getConfigDir, saveConfig, loadConfig, CONFIG_FILE, ensureUserDir } = require('../config');
const { validateAnthropic, validateTelegram, validateSupabase } = require('../auth/validators');
const { setupAnthropicOAuth } = require('./oauth');
const { setupSupabaseNew, setupSupabaseExisting } = require('./supabase-setup');
const { restore } = require('./github');
const {
  checkNodeVersion, validateCredential, promptApiKey,
  collectAllowedUsers, ensureDirs, createPersonalityFiles,
} = require('./init-utils');

const OBOL_DIR = getConfigDir();

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

  // Step 5: Access control
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

module.exports = { init };
