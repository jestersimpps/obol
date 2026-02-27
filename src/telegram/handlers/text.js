const { InlineKeyboard } = require('grammy');
const { getTenant } = require('../../tenant');
const { buildStatusHtml, describeToolCall } = require('../../status');
const { sendHtml, startTyping, splitMessage } = require('../utils');
const { TEXT_BUFFER_GAP_MS, TEXT_BUFFER_MAX_PARTS, TEXT_BUFFER_MAX_CHARS, TEXT_BUFFER_THRESHOLD } = require('../constants');

const textBuffers = new Map();
const VERBOSE_FLUSH_MS = 2000;

async function sendTtsVoiceSummary(ctx, tenant, responseText) {
  const fs = require('fs');
  const { InputFile } = require('grammy');
  const tts = require('../../tts');

  const ttsConfig = tenant.toolPrefs.get('text_to_speech')?.config || {};
  const voice = ttsConfig.voice || 'en-US-JennyNeural';

  const summaryRes = await tenant.claude.client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Summarize the following assistant message in 1-2 short spoken sentences. Use plain conversational language — no markdown, no code, no lists. Just what was said or done:\n\n${responseText.substring(0, 3000)}`,
    }],
  });

  const summary = summaryRes.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!summary) return;

  const filePath = tts.synthesize(summary, voice, { rate: ttsConfig.rate, pitch: ttsConfig.pitch });
  try {
    await ctx.replyWithAudio(new InputFile(filePath));
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

function createVerboseBatcher(ctx) {
  /** @type {string[]} */
  let buffer = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (buffer.length === 0) return;
    const raw = buffer.join('\n');
    buffer = [];
    const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    ctx.reply(`<code>${escaped}</code>`, { parse_mode: 'HTML' }).catch(() =>
      ctx.reply(raw).catch(() => {})
    );
  };

  const notify = (/** @type {string} */ msg) => {
    buffer.push(msg);
    if (!timer) timer = setTimeout(flush, VERBOSE_FLUSH_MS);
  };

  return { notify, flush };
}

function createChatContext(ctx, tenant, config, { allowedUsers, bot, createAsk }) {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || 'User';
  return {
    userId,
    userName,
    chatId: ctx.chat.id,
    bg: tenant.bg,
    ctx,
    claude: tenant.claude,
    scheduler: tenant.scheduler,
    messageLog: tenant.messageLog,
    toolPrefs: tenant.toolPrefs,
    config,
    verbose: tenant.verbose,
    _verboseBatcher: null,
    _verboseNotify: undefined,
    telegramAsk: (message, options, timeout) => createAsk(ctx, message, options, timeout),
    _notifyFn: (targetUserId, message, opts = {}) => {
      if (!allowedUsers.has(targetUserId)) throw new Error('Cannot notify user outside allowed list');
      return bot.api.sendMessage(targetUserId, message, opts);
    },
  };
}

function createStatusTracker(ctx, botName) {
  let statusMsgId = null;
  let statusText = 'Processing';
  let statusTimer = null;
  let statusStart = null;
  let routeInfo = null;
  const title = botName || 'OBOL';
  const stopBtn = new InlineKeyboard()
    .text('■ Stop', `stop:${ctx.chat.id}`)
    .text('■ Force Stop', `force:${ctx.chat.id}`);

  const clear = () => {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (statusMsgId) { ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => {}); statusMsgId = null; }
  };

  const start = () => {
    if (statusTimer) return;
    statusStart = Date.now();
    const html = buildStatusHtml({ route: routeInfo, elapsed: 0, toolStatus: statusText, title });
    ctx.reply(html, { parse_mode: 'HTML', reply_markup: stopBtn }).then(sent => {
      if (sent) statusMsgId = sent.message_id;
    }).catch(() => {});
    statusTimer = setInterval(() => {
      if (!statusMsgId) return;
      const elapsed = Math.round((Date.now() - statusStart) / 1000);
      const html = buildStatusHtml({ route: routeInfo, elapsed, toolStatus: statusText, title });
      ctx.api.editMessageText(ctx.chat.id, statusMsgId, html, { parse_mode: 'HTML', reply_markup: stopBtn }).catch(() => {});
    }, 5000);
  };

  return {
    clear,
    start,
    get statusMsgId() { return statusMsgId; },
    get statusStart() { return statusStart; },
    get routeInfo() { return routeInfo; },
    setStatusText(t) { statusText = t; },
    setRouteInfo(r) { routeInfo = r; },
    stopTimer() {
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    },
    updateFormatting() {
      if (!statusMsgId) return;
      const elapsed = statusStart ? Math.round((Date.now() - statusStart) / 1000) : 0;
      const html = buildStatusHtml({ route: routeInfo, elapsed, toolStatus: 'Formatting output', title });
      ctx.api.editMessageText(ctx.chat.id, statusMsgId, html, { parse_mode: 'HTML' }).catch(() => {});
    },
    deleteMsg() {
      if (statusMsgId) ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => {});
    },
  };
}

async function processTextMessage(ctx, fullMessage, { config, allowedUsers, bot, createAsk }) {
  const userId = ctx.from.id;
  const tenant = await getTenant(userId, config);

  let replyContext = '';
  const reply = ctx.message?.reply_to_message;
  if (reply) {
    const quote = (reply.text || reply.caption || '').substring(0, 500);
    const sender = reply.from
      ? (reply.from.first_name || '') + (reply.from.last_name ? ` ${reply.from.last_name}` : '')
      : reply.forward_origin?.sender_user?.first_name || 'someone';
    if (quote) replyContext = `[Replying to "${quote}" from ${sender}]\n\n`;
  }

  const chatMessage = replyContext + fullMessage;
  const stopTyping = startTyping(ctx);
  const status = createStatusTracker(ctx, config.bot?.name);

  const batcher = tenant.verbose ? createVerboseBatcher(ctx) : null;
  try {
    if (tenant.messageLog) {
      if (batcher) {
        tenant.messageLog._verboseCallbacks.set(ctx.chat.id, batcher.notify);
      } else {
        tenant.messageLog._verboseCallbacks.delete(ctx.chat.id);
      }
    }
    tenant.messageLog?.log(ctx.chat.id, 'user', chatMessage);

    const chatContext = createChatContext(ctx, tenant, config, { allowedUsers, bot, createAsk });
    if (batcher) {
      chatContext._verboseNotify = batcher.notify;
      chatContext._verboseBatcher = batcher;
    }
    chatContext._onRouteDecision = (info) => {
      status.setRouteInfo(info);
      status.start();
    };
    chatContext._onRouteUpdate = (update) => {
      const ri = status.routeInfo;
      if (!ri) return;
      if (update.memoryCount !== undefined) ri.memoryCount = update.memoryCount;
      if (update.selfMemoryCount !== undefined) ri.selfMemoryCount = update.selfMemoryCount;
      if (update.model) ri.model = update.model;
    };
    chatContext._onToolStart = (toolName, inputSummary) => {
      status.setStatusText('Processing');
      describeToolCall(tenant.claude.client, toolName, inputSummary).then(desc => {
        if (desc) status.setStatusText(desc);
      });
      status.start();
    };
    chatContext._onLockTimeout = () => {
      status.clear();
      ctx.api.sendMessage(ctx.chat.id, 'Request timed out after 10 minutes. Send a new message to continue.').catch(() => {});
    };

    const { text: response, usage, model } = await tenant.claude.chat(chatMessage, chatContext);

    batcher?.flush();
    status.stopTimer();
    status.updateFormatting();

    if (!response?.trim()) {
      stopTyping();
      status.deleteMsg();
      await ctx.reply('⏹ Stopped.').catch(() => {});
      return;
    }

    tenant.messageLog?.log(ctx.chat.id, 'assistant', response, { model, tokensIn: usage?.input_tokens, tokensOut: usage?.output_tokens });

    const { maybeImpulse } = require('../../curiosity/impulse');
    maybeImpulse(bot, config, tenant, ctx.chat.id, chatMessage, response).catch(() => {});

    stopTyping();

    if (response.length > 4096) {
      const chunks = splitMessage(response, 4096);
      for (const chunk of chunks) {
        await sendHtml(ctx, chunk).catch(() => {});
      }
    } else {
      await sendHtml(ctx, response).catch(() => {});
    }

    const ttsPref = tenant.toolPrefs?.get('text_to_speech');
    if (ttsPref?.enabled) {
      sendTtsVoiceSummary(ctx, tenant, response).catch(e => console.error('[tts] Auto-summary failed:', e.message));
    }

    if (usage && model) {
      const tag = model.includes('opus') ? 'opus' : model.includes('haiku') ? 'haiku' : 'sonnet';
      const tokIn = usage.input_tokens >= 1000 ? `${(usage.input_tokens/1000).toFixed(1)}k` : usage.input_tokens;
      const tokOut = usage.output_tokens >= 1000 ? `${(usage.output_tokens/1000).toFixed(1)}k` : usage.output_tokens;
      const dur = status.statusStart ? ((Date.now() - status.statusStart)/1000).toFixed(1) : null;
      const parts = [`◈ ${tag}`, `${tokIn} in`, `${tokOut} out`];
      if (dur) parts.push(`${dur}s`);
      await ctx.reply(`<code>${parts.join(' ▪ ')}</code>`, { parse_mode: 'HTML' }).catch(() => {});
    }

    status.deleteMsg();
  } catch (e) {
    batcher?.flush();
    status.clear();
    stopTyping();
    console.error('Message handling error:', e.message);
    const errMsg = e.isOAuthExpiry
      ? `OAuth error: ${e.message}\n\nRun \`obol reauth\` to re-authenticate.`
      : (e.status === 401 || e.message?.includes('401'))
        ? 'API key invalid or expired. Run `obol config` to update.'
        : (e.status === 429 || e.message?.includes('rate'))
          ? 'Rate limited. Wait a moment and try again.'
          : 'Something went wrong. Check logs with `obol logs`.';
    if (e.isOAuthExpiry) console.error('[oauth] Full error:', e.stack || e.message);
    await ctx.reply(errMsg).catch(() => {});
  }
}

function flushTextBuffer(chatId, ctx, deps) {
  const buf = textBuffers.get(chatId);
  if (!buf) return;
  clearTimeout(buf.timer);
  textBuffers.delete(chatId);
  const combined = buf.parts.join('');
  processTextMessage(ctx, combined, deps).catch(e => console.error('Buffer flush error:', e.message));
}

function registerTextHandler(bot, { config, allowedUsers, createAsk }) {
  const deps = { config, allowedUsers, bot, createAsk };

  bot.on('message:text', async (ctx) => {
    if (!ctx.from) return;
    const userMessage = ctx.message.text;
    if (!userMessage || !userMessage.trim()) return;
    const userId = ctx.from.id;

    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
      const me = await bot.api.getMe();
      if (!userMessage.includes(`@${me.username}`)) return;
    }

    const { containsApiKey, createRateLimiter } = require('../rate-limit');
    if (!bot._rateLimiter) bot._rateLimiter = createRateLimiter();

    if (!userMessage.startsWith('/secret') && containsApiKey(userMessage)) {
      ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      await ctx.reply(
        '⚠️ That message contained what looks like an API key or token. I deleted it, but it may have been seen already — consider rotating it.\n\nUse `/secret set <name> <value>` to store credentials safely.'
      ).catch(() => {});
      return;
    }

    const rateResult = bot._rateLimiter.check(userId);
    if (rateResult === 'cooldown' || rateResult === 'skip') return;
    if (rateResult === 'spam') {
      await ctx.reply('Spam detected. Cooling down for 30 seconds.').catch(() => {});
      return;
    }
    if (rateResult === 'slow') {
      await ctx.reply('Slow down a bit — I\'m still processing.').catch(() => {});
      return;
    }

    const chatId = ctx.chat.id;
    const existingBuf = textBuffers.get(chatId);

    if (userMessage.length >= TEXT_BUFFER_THRESHOLD) {
      if (existingBuf) {
        clearTimeout(existingBuf.timer);
        if (existingBuf.parts.length < TEXT_BUFFER_MAX_PARTS &&
            existingBuf.totalLength + userMessage.length <= TEXT_BUFFER_MAX_CHARS) {
          existingBuf.parts.push(userMessage);
          existingBuf.totalLength += userMessage.length;
          existingBuf.ctx = ctx;
          existingBuf.timer = setTimeout(() => flushTextBuffer(chatId, ctx, deps), TEXT_BUFFER_GAP_MS);
          return;
        }
        flushTextBuffer(chatId, ctx, deps);
      }
      const buf = {
        parts: [userMessage],
        totalLength: userMessage.length,
        ctx,
        timer: setTimeout(() => flushTextBuffer(chatId, ctx, deps), TEXT_BUFFER_GAP_MS),
      };
      textBuffers.set(chatId, buf);
      return;
    }

    if (existingBuf) {
      flushTextBuffer(chatId, existingBuf.ctx, deps);
    }

    await processTextMessage(ctx, userMessage, deps);
  });
}

module.exports = { processTextMessage, registerTextHandler, createChatContext, createStatusTracker };
