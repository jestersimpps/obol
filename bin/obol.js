#!/usr/bin/env node

const { Command } = require('commander');
const pkg = require('../package.json');

const program = new Command();

program
  .name('obol')
  .description('🪙 OBOL — Your AI, your rules.')
  .version(pkg.version);

program
  .command('init')
  .description('Set up your OBOL instance')
  .option('--restore', 'Restore from GitHub backup')
  .option('--reset', 'Erase config and re-run setup')
  .action(async (opts) => {
    const { init } = require('../src/cli/init');
    await init(opts);
  });

program
  .command('config')
  .description('View and edit configuration')
  .action(async () => {
    const { config } = require('../src/cli/config');
    await config();
  });

program
  .command('start')
  .description('Start the bot')
  .option('-d, --daemon', 'Run as background daemon')
  .action(async (opts) => {
    const { start } = require('../src/cli/start');
    await start(opts);
  });

program
  .command('stop')
  .description('Stop the bot')
  .action(async () => {
    const { stop } = require('../src/cli/stop');
    await stop();
  });

program
  .command('logs')
  .description('Tail bot logs')
  .option('-n, --lines <n>', 'Number of lines', '50')
  .action(async (opts) => {
    const { logs } = require('../src/cli/logs');
    await logs(opts);
  });

program
  .command('status')
  .description('Show bot status')
  .action(async () => {
    const { status } = require('../src/cli/status');
    await status();
  });

program
  .command('backup')
  .description('Manual backup to GitHub')
  .action(async () => {
    const { backup } = require('../src/cli/backup');
    await backup();
  });

program
  .command('upgrade')
  .description('Update to the latest version')
  .action(async () => {
    const { upgrade } = require('../src/cli/upgrade');
    await upgrade();
  });

program.parse();
