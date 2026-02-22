const { Bot } = require('grammy');
const {
  isFirstRun, markFirstRunComplete, FIRST_RUN_SYSTEM,
  parseSetupResponse, cleanResponse, writePersonalityFromSetup,
} = require('./first-run');
const { loadConfig } = require('./config');

function createBot(telegramConfig, claude, memory) {
  const bot = new Bot(telegramConfig.token);
  const allowedUsers = new Set(telegramConfig.allowedUsers || []);
  const firstRunHistory = []; // Separate history for onboarding conversation

  // Auth middleware
  bot.use(async (ctx, next) => {
    if (allowedUsers.size > 0 && !allowedUsers.has(ctx.from?.id)) {
      return; // Silently ignore unauthorized users
    }
    await next();
  });

  // Handle /start
  bot.command('start', async (ctx) => {
    await ctx.reply('🪙 OBOL is ready. Just send me a message.');
  });

  // Handle /memory commands
  bot.command('memory', async (ctx) => {
    if (!memory) return ctx.reply('Memory not configured.');
    const args = ctx.message.text.split(' ').slice(1);
    const sub = args[0];

    if (sub === 'search' && args[1]) {
      const results = await memory.search(args.slice(1).join(' '));
      if (results.length === 0) return ctx.reply('No memories found.');
      const text = results.map((m, i) =>
        `${i + 1}. [${m.category}] ${m.content.substring(0, 100)}`
      ).join('\n');
      return ctx.reply(`🔍 Found ${results.length}:\n\n${text}`);
    }

    if (sub === 'stats') {
      const stats = await memory.stats();
      return ctx.reply(`📊 ${stats.total} memories\n\n${stats.breakdown}`);
    }

    return ctx.reply('Usage: /memory search <query> | /memory stats');
  });

  // Handle all text messages
  bot.on('message:text', async (ctx) => {
    const userMessage = ctx.message.text;
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || 'User';

    try {
      // Show typing indicator
      await ctx.replyWithChatAction('typing');

      let response;

      // First-run onboarding — OBOL learns about the user through conversation
      if (isFirstRun()) {
        firstRunHistory.push({ role: 'user', content: userMessage });

        const msg = await claude.client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: FIRST_RUN_SYSTEM,
          messages: firstRunHistory,
        });

        const fullText = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        firstRunHistory.push({ role: 'assistant', content: fullText });

        // Check if OBOL has gathered enough info
        const setup = parseSetupResponse(fullText);
        if (setup?.ready) {
          const config = loadConfig();
          writePersonalityFromSetup(setup, config?.bot?.name);
          markFirstRunComplete();
          // Reload personality in claude instance
          claude.reloadPersonality?.();
        }

        response = cleanResponse(fullText);
      } else {
        // Normal operation
        response = await claude.chat(userMessage, {
          userId,
          userName,
          chatId: ctx.chat.id,
        });
      }

      // Send response (split if too long)
      if (response.length > 4096) {
        const chunks = splitMessage(response, 4096);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() =>
            ctx.reply(chunk) // Fallback without markdown if parsing fails
          );
        }
      } else {
        await ctx.reply(response, { parse_mode: 'Markdown' }).catch(() =>
          ctx.reply(response)
        );
      }
    } catch (e) {
      console.error('Message handling error:', e.message);
      await ctx.reply('⚠️ Something went wrong. Check logs with `obol logs`.');
    }
  });

  // Handle photos/documents
  bot.on('message:photo', async (ctx) => {
    await ctx.reply('📷 Image support coming soon.');
  });

  return bot;
}

function splitMessage(text, maxLength) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Find last newline before limit
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

module.exports = { createBot };
