const { getTenant } = require('../../tenant');
const { describeToolCall } = require('../../status');
const { sendHtml, startTyping, splitMessage } = require('../utils');
const { createChatContext, createStatusTracker } = require('./text');

/**
 * @param {import('grammy').Context} ctx
 * @returns {string}
 */
function buildLocationPrompt(ctx) {
  const { latitude, longitude, live_period, heading, horizontal_accuracy } = ctx.message.location;
  const parts = [`[User shared their location: lat ${latitude}, lng ${longitude}`];
  if (live_period) parts.push(`live for ${live_period}s`);
  if (heading !== undefined) parts.push(`heading ${heading}°`);
  if (horizontal_accuracy !== undefined) parts.push(`accuracy ±${horizontal_accuracy}m`);
  return parts.join(', ') + ']';
}

/**
 * @param {import('grammy').Context} ctx
 * @returns {string}
 */
function buildVenuePrompt(ctx) {
  const { location, title, address, foursquare_id, google_place_id } = ctx.message.venue;
  let prompt = `[User shared a venue: "${title}" at ${address} (${location.latitude}, ${location.longitude})`;
  if (foursquare_id) prompt += `, Foursquare: ${foursquare_id}`;
  if (google_place_id) prompt += `, Google: ${google_place_id}`;
  return prompt + ']';
}

/**
 * @param {import('grammy').Context} ctx
 * @returns {string}
 */
function buildContactPrompt(ctx) {
  const { phone_number, first_name, last_name, vcard } = ctx.message.contact;
  const name = [first_name, last_name].filter(Boolean).join(' ');
  let prompt = `[User shared a contact: ${name}, ${phone_number}`;
  if (vcard) prompt += ` (vCard data included)`;
  return prompt + ']';
}

/**
 * @param {import('grammy').Context} ctx
 * @returns {string}
 */
function buildPollPrompt(ctx) {
  const { question, options, type, is_anonymous, allows_multiple_answers } = ctx.message.poll;
  const opts = options.map((o, i) => `${i + 1}. ${o.text}`).join(', ');
  let prompt = `[User shared a ${type || 'regular'} poll: "${question}" — Options: ${opts}`;
  if (!is_anonymous) prompt += ', non-anonymous';
  if (allows_multiple_answers) prompt += ', multiple answers allowed';
  return prompt + ']';
}

/**
 * @param {import('grammy').Context} ctx
 * @returns {string | null}
 */
function buildSpecialPrompt(ctx) {
  if (ctx.message.location && !ctx.message.venue) return buildLocationPrompt(ctx);
  if (ctx.message.venue) return buildVenuePrompt(ctx);
  if (ctx.message.contact) return buildContactPrompt(ctx);
  if (ctx.message.poll) return buildPollPrompt(ctx);
  return null;
}

/**
 * @param {import('grammy').Context} ctx
 * @param {string} prompt
 * @param {{ config: object, allowedUsers: Set<number>, bot: import('grammy').Bot, createAsk: Function }} deps
 */
async function processSpecial(ctx, prompt, deps) {
  if (!ctx.from) return;
  const userId = ctx.from.id;
  const stopTyping = startTyping(ctx);
  const status = createStatusTracker(ctx, deps.config?.bot?.name);

  try {
    const tenant = await getTenant(userId, deps.config);
    const chatCtx = createChatContext(ctx, tenant, deps.config, deps);

    chatCtx._onRouteDecision = (info) => {
      status.setRouteInfo(info);
      status.start();
    };
    chatCtx._onRouteUpdate = (update) => {
      const ri = status.routeInfo;
      if (!ri) return;
      if (update.memoryCount !== undefined) ri.memoryCount = update.memoryCount;
      if (update.model) ri.model = update.model;
    };
    chatCtx._onToolStart = (toolName, inputSummary) => {
      status.setStatusText('Processing');
      describeToolCall(tenant.claude.client, toolName, inputSummary).then(desc => {
        if (desc) status.setStatusText(desc);
      });
      status.start();
    };

    const { text: response, usage, model } = await tenant.claude.chat(prompt, chatCtx);

    status.stopTimer();
    status.updateFormatting();
    stopTyping();

    if (!response?.trim()) {
      status.deleteMsg();
      await ctx.reply('⏹ Stopped.').catch(() => {});
      return;
    }

    tenant.messageLog?.log(ctx.chat.id, 'user', prompt);
    tenant.messageLog?.log(ctx.chat.id, 'assistant', response, { model, tokensIn: usage?.input_tokens, tokensOut: usage?.output_tokens });

    if (response.length > 4096) {
      for (const chunk of splitMessage(response, 4096)) await sendHtml(ctx, chunk).catch(() => {});
    } else {
      await sendHtml(ctx, response).catch(() => {});
    }

    if (usage && model) {
      const tag = model.includes('opus') ? 'opus' : model.includes('haiku') ? 'haiku' : 'sonnet';
      const tokIn = usage.input_tokens >= 1000 ? `${(usage.input_tokens / 1000).toFixed(1)}k` : usage.input_tokens;
      const tokOut = usage.output_tokens >= 1000 ? `${(usage.output_tokens / 1000).toFixed(1)}k` : usage.output_tokens;
      const dur = status.statusStart ? ((Date.now() - status.statusStart) / 1000).toFixed(1) : null;
      const parts = [`◈ ${tag}`, `${tokIn} in`, `${tokOut} out`];
      if (dur) parts.push(`${dur}s`);
      await ctx.reply(`<code>${parts.join(' ▪ ')}</code>`, { parse_mode: 'HTML' }).catch(() => {});
    }

    status.deleteMsg();
  } catch (e) {
    status.clear();
    stopTyping();
    console.error('Special message handling error:', e.message);
    await ctx.reply('Failed to process that message. Check logs.').catch(() => {});
  }
}

/**
 * @param {import('grammy').Bot} bot
 * @param {{ config: object, allowedUsers: Set<number>, bot: import('grammy').Bot, createAsk: Function }} deps
 */
function registerSpecialHandler(bot, deps) {
  async function handleSpecial(ctx) {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const { createRateLimiter } = require('../rate-limit');
    if (!bot._rateLimiter) bot._rateLimiter = createRateLimiter();
    if (bot._rateLimiter.check(userId)) return;

    const prompt = buildSpecialPrompt(ctx);
    if (!prompt) return;

    await processSpecial(ctx, prompt, deps);
  }

  bot.on('message:location', handleSpecial);
  bot.on('message:venue', handleSpecial);
  bot.on('message:contact', handleSpecial);
  bot.on('message:poll', handleSpecial);
}

module.exports = { registerSpecialHandler };
