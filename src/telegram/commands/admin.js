const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getTenant } = require('../../tenant');
const { loadConfig } = require('../../config');
const { getMaxToolIterations, setMaxToolIterations } = require('../../claude');
const { createChatContext, createStatusTracker } = require('../handlers/text');
const { sendHtml, splitMessage, startTyping } = require('../utils');
const pkg = require('../../../package.json');

function register(bot, config, createAsk) {
  const botName = config.bot?.name || 'OBOL';
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
    const { planClean } = require('../../clean');
    await ctx.replyWithChatAction('typing');
    try {
      const plan = await planClean(tenant.userDir);
      const testsDir = path.join(plan.baseDir, 'tests');
      const scriptsDir = path.join(plan.baseDir, 'scripts');
      const hasTests = fs.existsSync(testsDir) && fs.readdirSync(testsDir).filter(f => !f.startsWith('.')).length > 0;
      const hasScripts = fs.existsSync(scriptsDir) && fs.readdirSync(scriptsDir).filter(f => !f.startsWith('.')).length > 0;

      if (plan.issues.length === 0 && (hasTests || !hasScripts)) {
        await ctx.reply('✨ Workspace is clean. Nothing out of place.');
        return;
      }

      const promptParts = [];

      if (plan.issues.length > 0) {
        const issueLines = plan.issues.map(i => {
          const src = i.type === 'misplaced' ? `${i.currentDir}/${i.name}` : (i.type === 'dir' ? i.name + '/' : i.name);
          return i.dest ? `- ${src} → ${i.dest}/` : `- ${src} (unknown type)`;
        }).join('\n');

        promptParts.push(`Clean up the obol workspace located at: ${plan.baseDir}

## Workspace Structure
Allowed root directories: personality/, scripts/, tests/, commands/, apps/, logs/, assets/
Allowed root files: config.json, secrets.json, .evolution-state.json, .first-run-done, .post-setup-done
- personality/ and commands/ only contain .md files
- Unknown directories at the root should be moved into apps/
- Script files (.js, .ts, .sh, etc.) go into scripts/
- Asset files (images, audio, pdf, etc.) go into assets/
- .DS_Store and other dotfiles should be deleted
- secrets.json must NOT be moved

## Issues Found
${issueLines}

Resolve all of these issues. Use the exec tool to run shell commands (mv, rm, mkdir) to move or delete files as appropriate.`);
      }

      promptParts.push(`## Secret Hygiene
Read every script in ${plan.baseDir}/scripts/. If any script has hardcoded API keys, passwords, tokens, or credentials (e.g. API_KEY = "sk-...", PASSWORD = "..."), refactor it:
1. Use \`store_secret\` to save each hardcoded value under a descriptive key (e.g. "deepseek-api-key")
2. Rewrite the script to accept a JSON secrets object as its first argument:
   \`\`\`python
   import json, sys
   secrets = json.loads(sys.argv[1])
   api_key = secrets.get('deepseek-api-key', '').strip()
   \`\`\`
3. Never leave plaintext secrets in script files

Summarize what was cleaned and secrets migrated.`);

      const taskPrompt = promptParts.join('\n\n');

      const stopTyping = startTyping(ctx);
      const status = createStatusTracker(ctx, config.bot?.name);
      const chatContext = createChatContext(ctx, tenant, config, { allowedUsers: new Set(), bot, createAsk });
      chatContext._model = 'claude-sonnet-4-6';
      chatContext._onRouteDecision = (info) => { status.setRouteInfo(info); status.start(); };
      chatContext._onToolStart = (toolName, inputSummary) => {
        status.setStatusText('Cleaning');
        status.start();
      };

      try {
        const { text: response } = await tenant.claude.chat(taskPrompt, chatContext);
        status.stopTimer();
        status.updateFormatting();
        stopTyping();
        status.deleteMsg();
        if (response?.trim()) {
          const chunks = splitMessage(response, 4096);
          for (const chunk of chunks) await sendHtml(ctx, chunk).catch(() => {});
        }
      } catch (e) {
        status.clear();
        stopTyping();
        await ctx.reply(`⚠️ Clean failed: ${e.message}`).catch(() => {});
      }

      // Phase 2: write and run tests (separate chat so it can't be skipped)
      const testsAfter = fs.existsSync(testsDir) && fs.readdirSync(testsDir).filter(f => !f.startsWith('.')).length > 0;
      if (!testsAfter && hasScripts) {
        const testPrompt = `Read every script in ${plan.baseDir}/scripts/. For each script, write a corresponding test file in ${plan.baseDir}/tests/. Name each test file test-<script-name> (e.g. scripts/gmail-send.py → tests/test-gmail-send.py). After writing all tests, run them and fix any failures until they all pass. Summarize the test results.`;
        const testStatus = createStatusTracker(ctx, config.bot?.name);
        const testCtx = createChatContext(ctx, tenant, config, { allowedUsers: new Set(), bot, createAsk });
        testCtx._model = 'claude-sonnet-4-6';
        testCtx._onRouteDecision = (info) => { testStatus.setRouteInfo(info); testStatus.start(); };
        testCtx._onToolStart = () => { testStatus.setStatusText('Writing tests'); testStatus.start(); };
        const testTyping = startTyping(ctx);
        try {
          const { text: testResponse } = await tenant.claude.chat(testPrompt, testCtx);
          testStatus.stopTimer();
          testStatus.updateFormatting();
          testTyping();
          testStatus.deleteMsg();
          if (testResponse?.trim()) {
            const chunks = splitMessage(testResponse, 4096);
            for (const chunk of chunks) await sendHtml(ctx, chunk).catch(() => {});
          }
        } catch (e) {
          testStatus.clear();
          testTyping();
          await ctx.reply(`⚠️ Test writing failed: ${e.message}`).catch(() => {});
        }
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
      try { execSync('pm2 restart obol', { encoding: 'utf-8', timeout: 15000 }); } catch {}
    } catch (e) {
      await ctx.reply(`Upgrade failed: ${e.message.substring(0, 200)}`);
    }
  });

  bot.command('toolimit', async (ctx) => {
    if (!ctx.from) return;
    const args = ctx.message.text.split(' ').slice(1);
    const current = getMaxToolIterations();

    if (!args[0]) {
      await ctx.reply(`🔧 Max tool iterations: ${current}\n\nThis limits how many tool calls ${botName} can make per message. Higher = more complex tasks, but slower responses.\n\nSet: /toolimit <number>\nExample: /toolimit 50`);
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
