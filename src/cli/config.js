const inquirer = require('inquirer');
const { loadConfig, saveConfig, CONFIG_FILE } = require('../config');

const SECTIONS = [
  {
    name: 'Anthropic',
    fields: [
      { key: 'anthropic.apiKey', label: 'API Key', secret: true },
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
    name: 'Access Control',
    fields: [
      { key: 'telegram.allowedUsers', label: 'Allowed Telegram User IDs', secret: false },
    ],
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
];

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

function maskSecret(value) {
  const str = String(value);
  if (str.length <= 8) return '****';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function formatValue(value, secret) {
  if (value === undefined || value === null) return '(not set)';
  if (Array.isArray(value)) return value.join(', ');
  if (secret) return maskSecret(value);
  return String(value);
}

async function config() {
  const cfg = loadConfig({ resolve: false });
  if (!cfg) {
    console.log('\n  No config found. Run "obol init" first.\n');
    return;
  }

  let editing = true;
  while (editing) {
    const { section } = await inquirer.prompt([{
      type: 'list',
      name: 'section',
      message: 'Config section:',
      choices: [
        ...SECTIONS.map(s => s.name),
        new inquirer.Separator(),
        'Done',
      ],
    }]);

    if (section === 'Done') break;

    const sec = SECTIONS.find(s => s.name === section);
    const fieldChoices = sec.fields.map(f => {
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

    const currentVal = getNestedValue(cfg, field.key);

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
    } else if (field.key === 'telegram.allowedUsers') {
      const currentDisplay = Array.isArray(currentVal) ? currentVal.join(', ') : '';
      const { newVal } = await inquirer.prompt([{
        type: 'input',
        name: 'newVal',
        message: `${field.label} (comma-separated):`,
        default: currentDisplay,
        validate: (v) => v.split(',').every(id => /^\d+$/.test(id.trim())) ? true : 'Must be numeric IDs',
      }]);
      setNestedValue(cfg, field.key, newVal.split(',').map(id => parseInt(id.trim())));
    } else {
      const promptType = field.secret ? 'password' : 'input';
      const opts = {
        type: promptType,
        name: 'newVal',
        message: `${field.label}:`,
      };
      if (field.secret) {
        opts.mask = '*';
      } else {
        opts.default = currentVal != null ? String(currentVal) : '';
      }
      const { newVal } = await inquirer.prompt([opts]);
      setNestedValue(cfg, field.key, newVal);
    }

    saveConfig(cfg);
    console.log('  ✅ Saved\n');
  }

  console.log(`\n  Config: ${CONFIG_FILE}\n`);
}

module.exports = { config };
