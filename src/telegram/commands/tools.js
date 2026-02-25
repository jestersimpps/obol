const { InlineKeyboard } = require('grammy');
const { getTenant } = require('../../tenant');
const { OPTIONAL_TOOLS } = require('../../claude');
const { clearVoiceFlow, sendVoiceLanguagePicker } = require('../voice');
const { TERM_SEP } = require('../constants');

function buildToolsMessage(toolPrefs) {
  const lines = [`◈ TOOLS`, TERM_SEP, ``];
  for (const [key, feature] of Object.entries(OPTIONAL_TOOLS)) {
    const pref = toolPrefs.get(key);
    const enabled = pref?.enabled || false;
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
    const pref = toolPrefs.get(key);
    const enabled = pref?.enabled || false;
    keyboard.text(`${enabled ? '◉' : '○'} ${feature.label}`, `tool:${key}`);
    if ((i + 1) % 2 === 0 && i < entries.length - 1) keyboard.row();
  }
  return keyboard;
}

function register(bot, config) {
  bot.command('tools', async (ctx) => {
    if (!ctx.from) return;
    await clearVoiceFlow(ctx.from.id, bot);
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

  const tenant = await gt(ctx.from.id, cfg);
  if (!tenant.toolPrefsApi) return answer({ text: 'Not available' });

  const newEnabled = await tenant.toolPrefsApi.toggle(featureKey);
  await tenant.reloadToolPrefs();

  const feature = OPTIONAL_TOOLS[featureKey];
  await answer({ text: `${feature.label}: ${newEnabled ? 'ON' : 'OFF'}` });

  const text = buildToolsMessage(tenant.toolPrefs);
  const keyboard = buildToolsKeyboard(tenant.toolPrefs);
  ctx.editMessageText(`<pre>${text}</pre>`, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});

  if (newEnabled && Object.keys(feature.config).length > 0 && feature.config.voice) {
    sendVoiceLanguagePicker(ctx);
  }
}

module.exports = { register, handleToolCallback, buildToolsMessage, buildToolsKeyboard };
