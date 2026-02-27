const inquirer = require('inquirer');
const fs = require('fs');
const { ensureUserDir, getUserDir, isValidTimezone } = require('../config');
const { detectTelegramUserId } = require('./init-utils');
const { setNestedValue } = require('./config-utils');

/**
 * @param {string|null} token
 * @param {number} [limit=50]
 * @returns {Promise<Map<number, string>|null>}
 */
async function detectTelegramUsers(token, limit = 50) {
  return detectTelegramUserId(token, limit);
}

/**
 * @param {object} cfg
 * @param {Function} saveConfig
 */
async function manageUsers(cfg, saveConfig) {
  const currentUsers = cfg.telegram?.allowedUsers || [];

  let managing = true;
  while (managing) {
    console.log(`\n  Current users (${currentUsers.length}):`);
    if (currentUsers.length === 0) {
      console.log('    (none)');
    } else {
      for (const id of currentUsers) {
        const hasDir = fs.existsSync(getUserDir(id));
        const name = cfg.users?.[String(id)]?.name;
        const tz = cfg.users?.[String(id)]?.timezone;
        const label = [name, tz].filter(Boolean).join(' — ');
        console.log(`    ${id}${label ? ` (${label})` : ''}${hasDir ? ' ✅' : ' (no workspace yet)'}`);
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
        ...(currentUsers.length > 0 ? [{ name: 'Set user timezone', value: 'timezone' }] : []),
        ...(currentUsers.length > 0 ? [{ name: 'Remove user', value: 'remove' }] : []),
        new inquirer.Separator(),
        { name: 'Back', value: 'back' },
      ],
    }]);

    if (action === 'back') break;

    if (action === 'detect') {
      const token = cfg.telegram?.token;
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

    if (action === 'timezone') {
      const { tzId } = await inquirer.prompt([{
        type: 'list',
        name: 'tzId',
        message: 'Set timezone for which user?',
        choices: [
          ...currentUsers.map(id => {
            const name = cfg.users?.[String(id)]?.name;
            const tz = cfg.users?.[String(id)]?.timezone || cfg.timezone || 'UTC';
            return { name: `${id}${name ? ` — ${name}` : ''} (${tz})`, value: id };
          }),
          new inquirer.Separator(),
          { name: 'Cancel', value: null },
        ],
      }]);
      if (tzId !== null) {
        const currentTz = cfg.users?.[String(tzId)]?.timezone || cfg.timezone || '';
        const { newTz } = await inquirer.prompt([{
          type: 'input',
          name: 'newTz',
          message: `Timezone for user ${tzId} (IANA):`,
          default: currentTz,
          validate: (v) => isValidTimezone(v.trim()) ? true : 'Invalid IANA timezone (e.g. Europe/Brussels, America/New_York)',
        }]);
        if (!cfg.users) cfg.users = {};
        if (!cfg.users[String(tzId)]) cfg.users[String(tzId)] = {};
        cfg.users[String(tzId)].timezone = newTz.trim();
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

module.exports = { manageUsers, detectTelegramUsers };
