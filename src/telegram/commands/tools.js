const { InlineKeyboard } = require('grammy');
const { getTenant } = require('../../tenant');
const { OPTIONAL_TOOLS } = require('../../claude');
const { clearVoiceFlow, sendVoiceLanguagePicker } = require('../voice');
const { clearTopicFlow, sendTopicEditor } = require('../topics');
const { TERM_SEP } = require('../constants');

function isEnabled(pref, feature) {
  return pref ? pref.enabled : (feature.defaultEnabled || false);
}

function buildToolsMessage(toolPrefs) {
  const lines = [`◈ TOOLS`, TERM_SEP, ``];
  for (const [key, feature] of Object.entries(OPTIONAL_TOOLS)) {
    const enabled = isEnabled(toolPrefs.get(key), feature);
    lines.push(`  ${enabled ? '◉' : '○'} ${feature.label}`);
  }
  lines.push(``, TERM_SEP);
  return lines.join('\n');
}

function buildToolsKeyboard(toolPrefs) {
  const keyboard = new InlineKeyboard();
  const entries = Object.entries(OPTIONAL_TOOLS);
  for (let i = 0; i < entries.length; i++) {
    const [key, feature] = entries[i];
    const enabled = isEnabled(toolPrefs.get(key), feature);
    keyboard.text(`${enabled ? '◉' : '○'} ${feature.label}`, `tool:${key}`);
    if ((i + 1) % 2 === 0 && i < entries.length - 1) keyboard.row();
  }
  return keyboard;
}

function register(bot, config) {
  bot.command('tools', async (ctx) => {
    if (!ctx.from) return;
    await clearVoiceFlow(ctx.from.id, bot);
    await clearTopicFlow(ctx.from.id, bot);
    const tenant = await getTenant(ctx.from.id, config);
    await tenant.reloadToolPrefs();
    const text = buildToolsMessage(tenant.toolPrefs);
    const keyboard = buildToolsKeyboard(tenant.toolPrefs);
    await ctx.reply(`<pre>${text}</pre>`, { parse_mode: 'HTML', reply_markup: keyboard });
  });
}

async function handleToolCallback(ctx, featureKey, answer, { getTenant: gt, config: cfg, bot }) {
  if (!OPTIONAL_TOOLS[featureKey]) return answer({ text: 'Unknown tool' });
  if (!ctx.from) return answer();

  await clearVoiceFlow(ctx.from.id, bot);
  await clearTopicFlow(ctx.from.id, bot);

  const tenant = await gt(ctx.from.id, cfg);
  if (!tenant.toolPrefsApi) return answer({ text: 'Not available' });

  const feature = OPTIONAL_TOOLS[featureKey];
  const newEnabled = await tenant.toolPrefsApi.toggle(featureKey, feature.defaultEnabled);
  await tenant.reloadToolPrefs();

  await answer({ text: `${feature.label}: ${newEnabled ? 'ON' : 'OFF'}` });

  const text = buildToolsMessage(tenant.toolPrefs);
  const keyboard = buildToolsKeyboard(tenant.toolPrefs);
  ctx.editMessageText(`<pre>${text}</pre>`, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});

  if (newEnabled && Object.keys(feature.config).length > 0 && feature.config.voice) {
    sendVoiceLanguagePicker(ctx);
  }

  if (newEnabled && featureKey === 'proactive_news') {
    sendTopicEditor(ctx, cfg);
  }
}

module.exports = { register, handleToolCallback, buildToolsMessage, buildToolsKeyboard };
