const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const { getConfigDir, ensureUserDir } = require('../config');

const OBOL_DIR = getConfigDir();

function checkNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    console.error(`  ❌ Node.js 18+ required (you have ${process.version})`);
    process.exit(1);
  }
}

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

async function detectTelegramUserId(token, limit = 10) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=${limit}`);
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

module.exports = {
  checkNodeVersion,
  validateCredential,
  promptApiKey,
  detectTelegramUserId,
  collectAllowedUsers,
  ensureDirs,
  createPersonalityFiles,
};
