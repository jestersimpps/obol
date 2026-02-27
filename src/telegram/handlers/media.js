const path = require('path');
const { getTenant } = require('../../tenant');
const { buildStatusHtml, describeToolCall } = require('../../status');
const media = require('../../media');
const { sendHtml, startTyping, splitMessage } = require('../utils');
const { MAX_MEDIA_SIZE, MEDIA_GROUP_DELAY_MS } = require('../constants');
const { createChatContext, createStatusTracker } = require('./text');

const mediaGroups = new Map();

async function downloadMediaItem(ctx, fileInfo, telegramToken) {
  const file = await ctx.getFile();
  const buffer = await media.downloadFile(telegramToken, file.file_path);
  const filename = media.generateFilename(fileInfo, file.file_path);
  return { buffer, filename, fileInfo, caption: ctx.message.caption || '' };
}

async function processMediaItems(ctx, items, { config, allowedUsers, bot, createAsk }) {
  if (!ctx.from) return;
  const userId = ctx.from.id;
  const stopTyping = startTyping(ctx);
  const status = createStatusTracker(ctx, config.bot?.name);

  try {
    const tenant = await getTenant(userId, config);
    const assetsDir = path.join(tenant.userDir, 'assets');
    const imageBlocks = [];
    const nonImageParts = [];
    const caption = items.map(i => i.caption).filter(Boolean).join('\n') || '';

    for (const item of items) {
      const savedPath = media.saveFile(item.buffer, assetsDir, item.filename);

      if (tenant.memory && !media.isImage(item.fileInfo)) {
        const memContent = media.buildMemoryContent(item.fileInfo, item.filename, savedPath, item.caption);
        await tenant.memory.add(memContent, {
          category: 'resource', importance: 0.6,
          source: 'telegram-media', tags: [item.fileInfo.mediaType],
        }).catch(() => {});
      }

      if (media.isImage(item.fileInfo)) {
        imageBlocks.push(media.bufferToImageBlock(item.buffer, item.fileInfo.mimeType));
      } else if (
        (item.fileInfo.mediaType === 'voice' || item.fileInfo.mediaType === 'audio') &&
        tenant.toolPrefs?.get?.('speech_to_text')?.enabled === true
      ) {
        const { transcribe } = require('../../stt');
        const transcription = await transcribe(savedPath);
        nonImageParts.push(transcription
          ? `[Voice message transcription: ${transcription}]`
          : `[Voice message: ${savedPath} — transcription failed]`);
      } else {
        nonImageParts.push(item.caption
          ? `[User sent a ${item.fileInfo.mediaType}: ${item.filename}, saved at ${savedPath}] ${item.caption}`
          : `[User sent a ${item.fileInfo.mediaType}: ${item.filename}, saved at ${savedPath}. Use read_file to read its contents if needed.]`);
      }
    }

    let prompt, chatImages;
    if (imageBlocks.length > 0) {
      prompt = caption || `The user sent ${imageBlocks.length} image(s). Describe what you see and respond naturally.`;
      if (nonImageParts.length > 0) prompt += '\n\n' + nonImageParts.join('\n');
      chatImages = imageBlocks;
    } else {
      prompt = nonImageParts.join('\n');
    }

    const mediaChatCtx = createChatContext(ctx, tenant, config, { allowedUsers, bot, createAsk });
    if (chatImages) mediaChatCtx.images = chatImages;
    mediaChatCtx._onRouteDecision = (info) => {
      status.setRouteInfo(info);
      status.start();
    };
    mediaChatCtx._onRouteUpdate = (update) => {
      const ri = status.routeInfo;
      if (!ri) return;
      if (update.memoryCount !== undefined) ri.memoryCount = update.memoryCount;
      if (update.model) ri.model = update.model;
    };
    mediaChatCtx._onToolStart = (toolName, inputSummary) => {
      status.setStatusText('Processing');
      describeToolCall(tenant.claude.client, toolName, inputSummary).then(desc => {
        if (desc) status.setStatusText(desc);
      });
      status.start();
    };
    mediaChatCtx._onLockTimeout = () => {
      status.clear();
      ctx.api.sendMessage(ctx.chat.id, 'Request timed out after 10 minutes. Send a new message to continue.').catch(() => {});
    };

    const { text: response, usage, model } = await tenant.claude.chat(prompt, mediaChatCtx);

    status.stopTimer();
    status.updateFormatting();

    stopTyping();
    if (!response?.trim()) {
      status.deleteMsg();
      await ctx.reply('⏹ Stopped.').catch(() => {});
      return;
    }

    const logLabel = items.map(i => `[${i.fileInfo.mediaType}] ${i.caption || i.filename}`).join(', ');
    tenant.messageLog?.log(ctx.chat.id, 'user', logLabel);
    tenant.messageLog?.log(ctx.chat.id, 'assistant', response, { model, tokensIn: usage?.input_tokens, tokensOut: usage?.output_tokens });

    if (tenant.memory && imageBlocks.length > 0) {
      const filenames = items.filter(i => media.isImage(i.fileInfo)).map(i => i.filename).join(', ');
      const analysisMemory = `Images: ${filenames}${caption ? `. Caption: "${caption}"` : ''}. Analysis: ${response.substring(0, 1500)}`;
      await tenant.memory.add(analysisMemory, {
        category: 'resource', importance: 0.7,
        source: 'image-analysis',
        tags: ['image', ...(caption ? caption.toLowerCase().split(/\s+/).slice(0, 3) : [])],
      }).catch(() => {});
    }

    if (response.length > 4096) {
      const chunks = splitMessage(response, 4096);
      for (const chunk of chunks) await sendHtml(ctx, chunk).catch(() => {});
    } else {
      await sendHtml(ctx, response).catch(() => {});
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
    status.clear();
    stopTyping();
    console.error('Media handling error:', e.message);
    await ctx.reply('Failed to process that file. Check logs.').catch(() => {});
  }
}

function registerMediaHandler(bot, telegramConfig, deps) {
  async function handleMedia(ctx) {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const { createRateLimiter } = require('../rate-limit');
    if (!bot._rateLimiter) bot._rateLimiter = createRateLimiter();
    const rateResult = bot._rateLimiter.check(userId);
    if (rateResult) return;
    const fileInfo = media.getFileInfo(ctx);
    if (!fileInfo) return;

    if (fileInfo.fileSize > MAX_MEDIA_SIZE) {
      await ctx.reply(`File too large (${(fileInfo.fileSize / 1024 / 1024).toFixed(1)}MB). Max is 50MB.`).catch(() => {});
      return;
    }

    const item = await downloadMediaItem(ctx, fileInfo, telegramConfig.token).catch(e => {
      console.error('Media download error:', e.message);
      return null;
    });
    if (!item) return;

    const groupId = ctx.message.media_group_id;
    if (groupId) {
      const existing = mediaGroups.get(groupId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.items.push(item);
        existing.ctx = ctx;
        existing.timer = setTimeout(() => {
          mediaGroups.delete(groupId);
          processMediaItems(existing.ctx, existing.items, deps).catch(e =>
            console.error('Media group error:', e.message)
          );
        }, MEDIA_GROUP_DELAY_MS);
      } else {
        const group = {
          items: [item],
          ctx,
          timer: setTimeout(() => {
            mediaGroups.delete(groupId);
            processMediaItems(ctx, [item], deps).catch(e =>
              console.error('Media group error:', e.message)
            );
          }, MEDIA_GROUP_DELAY_MS),
        };
        mediaGroups.set(groupId, group);
      }
      return;
    }

    await processMediaItems(ctx, [item], deps);
  }

  bot.on('message:photo', handleMedia);
  bot.on('message:document', handleMedia);
  bot.on('message:voice', handleMedia);
  bot.on('message:video', handleMedia);
  bot.on('message:audio', handleMedia);
  bot.on('message:sticker', handleMedia);
  bot.on('message:animation', handleMedia);
  bot.on('message:video_note', handleMedia);
}

module.exports = { registerMediaHandler };
