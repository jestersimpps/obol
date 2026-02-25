const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getTenant } = require('../../tenant');
const { loadConfig } = require('../../config');
const { getMaxToolIterations, setMaxToolIterations } = require('../../claude');
const pkg = require('../../../package.json');

function register(bot, config) {
  bot.command('backup', async (ctx) => {
    if (!ctx.from) return;
    try {
      const cfg = loadConfig();
      if (!cfg?.github) return ctx.reply('GitHub backup not configured.');
      const tenant = await getTenant(ctx.from.id, config);
      const { runBackup } = require('../../backup');
      await ctx.reply('📦 Running backup...');
      await runBackup(cfg.github, null, tenant.userDir);
      await ctx.reply('✅ Backup complete');
    } catch (e) {
      await ctx.reply(`⚠️ Backup failed: ${e.message}`);
    }
  });

  bot.command('clean', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    const { cleanWorkspace } = require('../../clean');
    await ctx.replyWithChatAction('typing');
    try {
      const result = await cleanWorkspace(tenant.userDir, tenant.claude.client);
      if (result.issues.length === 0) {
        await ctx.reply('✨ Workspace is clean. Nothing out of place.');
      } else {
        const text = `🧹 Found ${result.issues.length} issue(s):\n\n` +
          result.issues.map(i => `${i.action === 'deleted' ? '🗑️' : '📦'} ${i.path} → ${i.action}`).join('\n') +
          (result.errors.length > 0 ? `\n\n⚠️ ${result.errors.length} error(s):\n${result.errors.join('\n')}` : '');
        await ctx.reply(text);
      }
    } catch (e) {
      await ctx.reply(`⚠️ Clean failed: ${e.message}`);
    }
  });

  bot.command('upgrade', async (ctx) => {
    const current = pkg.version;
    let latest;
    try {
      latest = execSync(`npm view ${pkg.name} version`, { encoding: 'utf-8' }).trim();
    } catch {
      await ctx.reply('Could not reach npm registry');
      return;
    }

    if (current === latest) {
      await ctx.reply(`Already on latest (${current})`);
      return;
    }

    await ctx.reply(`Upgrading ${current} → ${latest}, back in a moment...`);

    try {
      execSync(`npm install -g ${pkg.name}@latest`, { encoding: 'utf-8', timeout: 120000 });
      const { OBOL_DIR } = require('../../config');
      const notifyPath = path.join(OBOL_DIR, '.upgrade-notify.json');
      fs.writeFileSync(notifyPath, JSON.stringify({ chatId: ctx.chat.id, version: latest }));
      execSync('pm2 restart obol', { encoding: 'utf-8', timeout: 15000 });
    } catch (e) {
      await ctx.reply(`Upgrade failed: ${e.message.substring(0, 200)}`);
    }
  });

  bot.command('toolimit', async (ctx) => {
    if (!ctx.from) return;
    const args = ctx.message.text.split(' ').slice(1);
    const current = getMaxToolIterations();

    if (!args[0]) {
      await ctx.reply(`🔧 Max tool iterations: ${current}\n\nThis limits how many tool calls OBOL can make per message. Higher = more complex tasks, but slower responses.\n\nSet: /toolimit <number>\nExample: /toolimit 50`);
      return;
    }

    const value = parseInt(args[0], 10);
    if (isNaN(value) || value < 1 || value > 500) {
      await ctx.reply(`Invalid value: "${args[0]}"\n\nMust be a number between 1 and 500.\nCurrent: ${current}\n\nExample: /toolimit 50`);
      return;
    }

    setMaxToolIterations(value);
    await ctx.reply(`🔧 Max tool iterations set to ${value}`);
  });
}

module.exports = { register };
