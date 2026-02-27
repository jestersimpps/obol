const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, CONFIG_FILE, USERS_DIR } = require('../config');
const { getNestedValue, setNestedValue, formatValue, updatePassSecret } = require('./config-utils');
const { manageUsers } = require('./manage-users');
const { runOAuthFlow } = require('./oauth');

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
      await manageUsers(cfg, saveConfig);
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
        return { name: `${f.label}${status}`, value: f };
      }
      const val = getNestedValue(cfg, f.key);
      return { name: `${f.label}: ${formatValue(val, f.secret)}`, value: f };
    });

    const { field } = await inquirer.prompt([{
      type: 'list',
      name: 'field',
      message: `Edit ${section}:`,
      choices: [...fieldChoices, new inquirer.Separator(), { name: 'Back', value: null }],
    }]);

    if (!field) continue;

    if (field.custom === 'oauth') {
      await runOAuthFlow(cfg, setNestedValue, saveConfig);
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
