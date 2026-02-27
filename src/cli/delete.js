const fs = require('fs');
const { execFileSync } = require('child_process');
const inquirer = require('inquirer');
const { OBOL_DIR } = require('../config');
const { hasPassStore } = require('../auth/credentials');
const { stop } = require('./stop');

async function deleteAll() {
  const passAvailable = hasPassStore();
  const obolExists = fs.existsSync(OBOL_DIR);

  if (!obolExists && !passAvailable) {
    console.log('🪙 Nothing to delete — no OBOL data found');
    return;
  }

  console.log('\n⚠️  This will permanently delete ALL OBOL data:\n');
  if (obolExists) console.log(`  • ${OBOL_DIR}/`);
  if (passAvailable) console.log('  • pass entries under obol/');
  console.log();

  const { confirm } = await inquirer.prompt({
    type: 'confirm',
    name: 'confirm',
    message: 'This will permanently delete ALL OBOL data. Continue?',
    default: false,
  });

  if (!confirm) {
    console.log('🪙 Aborted');
    return;
  }

  const { typed } = await inquirer.prompt({
    type: 'input',
    name: 'typed',
    message: 'Type DELETE to confirm:',
  });

  if (typed !== 'DELETE') {
    console.log('🪙 Aborted');
    return;
  }

  await stop();

  if (passAvailable) {
    try {
      execFileSync('pass', ['rm', '-r', '--force', 'obol/'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {}
  }

  if (obolExists) {
    fs.rmSync(OBOL_DIR, { recursive: true, force: true });
  }

  console.log('🪙 All OBOL data deleted — run `obol init` to start fresh');
}

module.exports = { delete: deleteAll };
