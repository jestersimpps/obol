const inquirer = require('inquirer');
const { loadConfig, saveConfig, CONFIG_FILE, ensureUserDir, getUserDir, USERS_DIR } = require('../config');
const { generatePKCE, buildAuthorizationUrl, exchangeCodeForTokens } = require('../auth/oauth');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SECTIONS = [
  {
    name: 'Anthropic',
    fields: [
      { key: 'anthropic.apiKey', label: 'API Key', secret: true },
      { key: '_oauth_flow', label: 'Set up / reset OAuth', custom: 'oauth' },
      { key: 'anthropic.oauth.accessToken', label: 'OAuth Access Token (manual)', secret: true },
      { key: 'anthropic.oauth.refreshToken', label: 'OAuth Refresh Token (manual)', secret: true },
    ],
  },
  {
    name: 'Telegram',
    fields: [
      { key: 'telegram.token', label: 'Bot Token', secret: true },
    ],
  },
  {
    name: 'Supabase',
    fields: [
      { key: 'supabase.url', label: 'Project URL', secret: false },
      { key: 'supabase.serviceKey', label: 'Service Role Key', secret: true },
      { key: 'supabase.accessToken', label: 'Access Token (for migrations)', secret: true },
    ],
  },
  {
    name: 'GitHub',
    fields: [
      { key: 'github.token', label: 'Token', secret: true },
    ],
  },
  {
    name: 'Vercel',
    fields: [
      { key: 'vercel.token', label: 'Token', secret: true },
    ],
  },
  {
    name: 'Identity',
    fields: [
      { key: 'owner.name', label: 'Owner Name', secret: false },
      { key: 'bot.name', label: 'Bot Name', secret: false },
    ],
  },
  {
    name: 'Users',
    custom: true,
  },
  {
    name: 'Heartbeat',
    fields: [
      { key: 'heartbeat', label: 'Enabled (true/false)', secret: false, type: 'boolean' },
    ],
  },
  {
    name: 'Evolution',
    fields: [
      { key: 'evolution.exchanges', label: 'Exchanges between evolutions (default: 100)', secret: false, type: 'number' },
    ],
  },
  {
    name: 'Bridge',
    fields: [
      { key: 'bridge.enabled', label: 'Enabled', secret: false, type: 'boolean' },
    ],
  },
];

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (FORBIDDEN_KEYS.has(keys[i])) return;
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  const lastKey = keys[keys.length - 1];
  if (FORBIDDEN_KEYS.has(lastKey)) return;
  current[lastKey] = value;
}

function maskSecret(value) {
  const str = String(value);
  if (str.length <= 8) return '****';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function formatValue(value, secret) {
  if (value === undefined || value === null) return '(not set)';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string' && value.startsWith('pass:')) {
    if (!secret) return value;
    const passKey = value.slice(5);
    try {
      const { execSync } = require('child_process');
      const resolved = execSync(`pass show ${passKey}`, { encoding: 'utf-8' }).trim();
      return maskSecret(resolved);
    } catch {
      return '(pass key missing)';
    }
  }
  if (secret) return maskSecret(value);
  return String(value);
}

function updatePassSecret(passKey, newValue) {
  const result = spawnSync('pass', ['insert', '-f', '-m', passKey], {
    input: newValue,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

async function detectTelegramUsers(token) {
  if (!token) return null;
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=50`);
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

async function manageUsers(cfg) {
  const currentUsers = cfg.telegram?.allowedUsers || [];

  let managing = true;
  while (managing) {
    console.log(`\n  Current users (${currentUsers.length}):`);
    if (currentUsers.length === 0) {
      console.log('    (none)');
    } else {
      for (const id of currentUsers) {
        const hasDir = fs.existsSync(getUserDir(id));
        console.log(`    ${id}${hasDir ? ' ✅' : ' (no workspace yet)'}`);
      }
    }
    console.log('');

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'Manage users:',
      choices: [
        { name: 'Add user (detect from bot messages)', value: 'detect' },
        { name: 'Add user (enter ID manually)', value: 'manual' },
        ...(currentUsers.length > 0 ? [{ name: 'Rename user', value: 'rename' }] : []),
        ...(currentUsers.length > 0 ? [{ name: 'Remove user', value: 'remove' }] : []),
        new inquirer.Separator(),
        { name: 'Back', value: 'back' },
      ],
    }]);

    if (action === 'back') break;

    if (action === 'detect') {
      const token = getNestedValue(cfg, 'telegram.token');
      if (!token) {
        console.log('  ❌ No Telegram token configured — set it first\n');
        continue;
      }
      console.log('  Checking for messages...');
      const detected = await detectTelegramUsers(token);
      if (!detected || detected.size === 0) {
        console.log('  ❌ No messages found. Have users send a message to the bot first.\n');
        continue;
      }

      const newUsers = [...detected.entries()].filter(([id]) => !currentUsers.includes(id));
      if (newUsers.length === 0) {
        console.log('  All detected users are already allowed.\n');
        continue;
      }

      const choices = newUsers.map(([id, name]) => ({
        name: `${id} — ${name}`,
        value: id,
        checked: true,
      }));
      const { picked } = await inquirer.prompt([{
        type: 'checkbox',
        name: 'picked',
        message: 'Select users to add:',
        choices,
      }]);

      for (const id of picked) {
        if (!currentUsers.includes(id)) {
          currentUsers.push(id);
          ensureUserDir(id);
          console.log(`  ✅ Added ${id} — ${detected.get(id)}`);
        }
      }
    }

    if (action === 'manual') {
      const { newId } = await inquirer.prompt([{
        type: 'input',
        name: 'newId',
        message: 'Telegram user ID:',
        validate: (v) => {
          const id = v.trim();
          if (!/^\d+$/.test(id)) return 'Must be a numeric ID (e.g. 206639616)';
          if (id.length > 15) return 'ID too long — Telegram IDs are typically 9-10 digits';
          return true;
        },
      }]);
      const id = parseInt(newId.trim());
      if (currentUsers.includes(id)) {
        console.log(`  ⚠️  User ${id} already allowed\n`);
      } else {
        currentUsers.push(id);
        ensureUserDir(id);
        console.log(`  ✅ Added ${id} — workspace created`);
      }
    }

    if (action === 'rename') {
      const { renameId } = await inquirer.prompt([{
        type: 'list',
        name: 'renameId',
        message: 'Rename which user?',
        choices: [
          ...currentUsers.map(id => {
            const name = cfg.users?.[String(id)]?.name;
            return { name: name ? `${id} — ${name}` : String(id), value: id };
          }),
          new inquirer.Separator(),
          { name: 'Cancel', value: null },
        ],
      }]);
      if (renameId !== null) {
        const currentName = cfg.users?.[String(renameId)]?.name || '';
        const { newName } = await inquirer.prompt([{
          type: 'input',
          name: 'newName',
          message: `Name for user ${renameId}:`,
          default: currentName,
          validate: (v) => v.trim().length > 0 ? true : 'Required',
        }]);
        if (!cfg.users) cfg.users = {};
        if (!cfg.users[String(renameId)]) cfg.users[String(renameId)] = {};
        cfg.users[String(renameId)].name = newName.trim();
      }
    }

    if (action === 'remove') {
      const { removeId } = await inquirer.prompt([{
        type: 'list',
        name: 'removeId',
        message: 'Remove which user?',
        choices: [
          ...currentUsers.map(id => ({ name: String(id), value: id })),
          new inquirer.Separator(),
          { name: 'Cancel', value: null },
        ],
      }]);
      if (removeId !== null) {
        const idx = currentUsers.indexOf(removeId);
        if (idx !== -1) currentUsers.splice(idx, 1);
        console.log(`  ✅ Removed ${removeId}`);
        console.log(`  ⚠️  Workspace at ${getUserDir(removeId)} was NOT deleted (remove manually if needed)`);
      }
    }

    setNestedValue(cfg, 'telegram.allowedUsers', currentUsers);

    if (currentUsers.length >= 2 && !cfg.bridge?.enabled && (action === 'detect' || action === 'manual')) {
      const { bridgeEnabled } = await inquirer.prompt([{
        type: 'confirm',
        name: 'bridgeEnabled',
        message: 'You have 2+ users. Enable bridge between agents? (lets agents query each other)',
        default: true,
      }]);
      setNestedValue(cfg, 'bridge.enabled', bridgeEnabled);
    }

    saveConfig(cfg);
    console.log('  ✅ Saved');
  }
}

async function runOAuthFlow(cfg) {
  console.log('\n  Starting OAuth flow with Anthropic...\n');

  const { verifier, challenge } = await generatePKCE();
  const authUrl = buildAuthorizationUrl(challenge, verifier);

  console.log('  1. Open this URL in your browser:\n');
  console.log(`  ${authUrl}\n`);
  console.log('  2. Authorize the app, then copy the FULL redirect URL from your browser.\n');
  console.log('     It will look like: https://console.anthropic.com/oauth/code/callback?code=XXXXX#STATE\n');

  const { callbackInput } = await inquirer.prompt([{
    type: 'input',
    name: 'callbackInput',
    message: 'Paste the full callback URL or just the code:',
    validate: (v) => v.trim().length > 0 ? true : 'Required',
  }]);

  try {
    const input = callbackInput.trim();
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

    if (!code) {
      console.log('  No code found\n');
      return;
    }

    console.log('  Exchanging code for tokens...');
    const tokens = await exchangeCodeForTokens(code, state, verifier);

    setNestedValue(cfg, 'anthropic.oauth.accessToken', tokens.accessToken);
    setNestedValue(cfg, 'anthropic.oauth.refreshToken', tokens.refreshToken);
    setNestedValue(cfg, 'anthropic.oauth.expires', tokens.expires);
    saveConfig(cfg);

    console.log('  OAuth configured with access + refresh token');
    console.log(`  Token expires: ${new Date(tokens.expires).toISOString()}\n`);
  } catch (e) {
    console.log(`  OAuth flow failed: ${e.message}\n`);
  }
}

function updatePersonalityNames(oldBotName, newBotName, oldOwnerName, newOwnerName) {
  const { PERSONALITY_DIR } = require('../soul');

  if (oldBotName !== newBotName) {
    const soulPath = path.join(PERSONALITY_DIR, 'SOUL.md');
    if (fs.existsSync(soulPath)) {
      let content = fs.readFileSync(soulPath, 'utf-8');
      content = content.replace(new RegExp(`# SOUL\\.md — Who is ${oldBotName}\\?`, 'g'), `# SOUL.md — Who is ${newBotName}?`);
      content = content.replace(new RegExp(`\\*\\*Name:\\*\\* ${oldBotName}`, 'g'), `**Name:** ${newBotName}`);
      fs.writeFileSync(soulPath, content, 'utf-8');
    }
  }

  if (oldOwnerName !== newOwnerName) {
    const soulPath = path.join(PERSONALITY_DIR, 'SOUL.md');
    if (fs.existsSync(soulPath)) {
      let content = fs.readFileSync(soulPath, 'utf-8');
      content = content.replace(new RegExp(`\\*\\*Created by:\\*\\* ${oldOwnerName}`, 'g'), `**Created by:** ${newOwnerName}`);
      fs.writeFileSync(soulPath, content, 'utf-8');
    }
  }

  if (!fs.existsSync(USERS_DIR)) return;
  const users = fs.readdirSync(USERS_DIR).filter(u => {
    try { return fs.statSync(path.join(USERS_DIR, u)).isDirectory(); } catch { return false; }
  });
  for (const userId of users) {
    if (oldBotName !== newBotName) {
      const agentsPath = path.join(USERS_DIR, userId, 'personality', 'AGENTS.md');
      if (fs.existsSync(agentsPath)) {
        let content = fs.readFileSync(agentsPath, 'utf-8');
        content = content.replace(new RegExp(`# AGENTS\\.md — How ${oldBotName} Works`, 'g'), `# AGENTS.md — How ${newBotName} Works`);
        fs.writeFileSync(agentsPath, content, 'utf-8');
      }
    }
  }
}

async function config() {
  const cfg = loadConfig({ resolve: false });
  if (!cfg) {
    console.log('\n  No config found. Run "obol init" first.\n');
    return;
  }

  let editing = true;
  while (editing) {
    const userCount = (cfg.telegram?.allowedUsers || []).length;
    const { section } = await inquirer.prompt([{
      type: 'list',
      name: 'section',
      message: 'Config section:',
      choices: [
        ...SECTIONS.map(s => {
          if (s.name === 'Users') return { name: `Users (${userCount} allowed)`, value: s.name };
          return s.name;
        }),
        new inquirer.Separator(),
        'Done',
      ],
    }]);

    if (section === 'Done') break;

    const sec = SECTIONS.find(s => s.name === section);

    if (sec.custom) {
      await manageUsers(cfg);
      continue;
    }

    const fields = sec.fields;
    const fieldChoices = fields.map(f => {
      if (f.custom) {
        const hasOAuth = !!getNestedValue(cfg, 'anthropic.oauth.accessToken');
        const hasRefresh = !!getNestedValue(cfg, 'anthropic.oauth.refreshToken');
        const expires = getNestedValue(cfg, 'anthropic.oauth.expires');
        const expired = expires && Date.now() >= expires;
        let status = '';
        if (hasOAuth && hasRefresh && !expired) status = ' ✅';
        else if (hasOAuth && expired) status = ' ⚠️  expired';
        else if (hasOAuth && !hasRefresh) status = ' ⚠️  no refresh token';
        return {
          name: `${f.label}${status}`,
          value: f,
        };
      }
      const val = getNestedValue(cfg, f.key);
      return {
        name: `${f.label}: ${formatValue(val, f.secret)}`,
        value: f,
      };
    });

    const { field } = await inquirer.prompt([{
      type: 'list',
      name: 'field',
      message: `Edit ${section}:`,
      choices: [...fieldChoices, new inquirer.Separator(), { name: 'Back', value: null }],
    }]);

    if (!field) continue;

    if (field.custom === 'oauth') {
      await runOAuthFlow(cfg);
      continue;
    }

    const currentVal = getNestedValue(cfg, field.key);
    const oldBotName = cfg.bot?.name;
    const oldOwnerName = cfg.owner?.name;

    if (field.type === 'boolean') {
      const { newVal } = await inquirer.prompt([{
        type: 'confirm',
        name: 'newVal',
        message: `${field.label}:`,
        default: currentVal === true,
      }]);
      setNestedValue(cfg, field.key, newVal);
    } else if (field.type === 'number') {
      const { newVal } = await inquirer.prompt([{
        type: 'input',
        name: 'newVal',
        message: `${field.label}:`,
        default: currentVal != null ? String(currentVal) : '',
        validate: (v) => /^\d+$/.test(v.trim()) ? true : 'Must be a number',
      }]);
      setNestedValue(cfg, field.key, parseInt(newVal.trim()));
    } else {
      const promptType = field.secret ? 'password' : 'input';
      const isPassRef = typeof currentVal === 'string' && currentVal.startsWith('pass:');
      const opts = {
        type: promptType,
        name: 'newVal',
        message: `${field.label}:`,
      };
      if (field.secret) {
        opts.mask = '*';
        console.log(`  Current: ${formatValue(currentVal, true)}`);
      } else {
        opts.default = currentVal != null ? String(currentVal) : '';
      }
      const { newVal } = await inquirer.prompt([opts]);

      if (isPassRef) {
        const passKey = currentVal.slice(5);
        if (updatePassSecret(passKey, newVal)) {
          console.log(`  ✅ Updated in pass store (${passKey})`);
        } else {
          console.log(`  ⚠️  Failed to update pass store, saving to config directly`);
          setNestedValue(cfg, field.key, newVal);
        }
      } else {
        setNestedValue(cfg, field.key, newVal);
      }
    }

    saveConfig(cfg);

    if (section === 'Identity') {
      updatePersonalityNames(oldBotName, cfg.bot?.name, oldOwnerName, cfg.owner?.name);
    }

    console.log('  ✅ Saved\n');
  }

  console.log(`\n  Config: ${CONFIG_FILE}\n`);
}

module.exports = { config, runOAuthFlow };
