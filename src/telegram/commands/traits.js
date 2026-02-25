const path = require('path');
const { getTenant } = require('../../tenant');
const { loadTraits, saveTraits, DEFAULT_TRAITS } = require('../../personality');
const { formatTraits } = require('../utils');
const { TERM_SEP } = require('../constants');

function register(bot, config) {
  bot.command('traits', async (ctx) => {
    if (!ctx.from) return;
    const tenant = await getTenant(ctx.from.id, config);
    const personalityDir = path.join(tenant.userDir, 'personality');
    const args = ctx.message.text.split(' ').slice(1);

    if (args[0] === 'reset') {
      saveTraits(personalityDir, { ...DEFAULT_TRAITS });
      tenant.claude.reloadPersonality();
      const traits = { ...DEFAULT_TRAITS };
      const lines = [`◈ OBOL PERSONALITY MATRIX`, TERM_SEP, `RESET TO DEFAULTS`, ``, formatTraits(traits), TERM_SEP];
      await ctx.reply(`<pre>${lines.join('\n')}</pre>`, { parse_mode: 'HTML' });
      return;
    }

    if (args[0] && args[1]) {
      const traitName = args[0].toLowerCase();
      const value = parseInt(args[1], 10);
      if (!(traitName in DEFAULT_TRAITS)) {
        await ctx.reply(`Unknown trait: ${traitName}\nValid: ${Object.keys(DEFAULT_TRAITS).join(', ')}`);
        return;
      }
      if (isNaN(value) || value < 0 || value > 100) {
        await ctx.reply('Value must be 0-100');
        return;
      }
      const traits = loadTraits(personalityDir);
      traits[traitName] = value;
      saveTraits(personalityDir, traits);
      tenant.claude.reloadPersonality();
      const lines = [`◈ OBOL PERSONALITY MATRIX`, TERM_SEP, `UPDATED ${traitName} → ${value}`, ``, formatTraits(traits), TERM_SEP];
      await ctx.reply(`<pre>${lines.join('\n')}</pre>`, { parse_mode: 'HTML' });
      return;
    }

    const traits = loadTraits(personalityDir);
    const lines = [`◈ OBOL PERSONALITY MATRIX`, TERM_SEP, ``, formatTraits(traits), ``, `/traits &lt;name&gt; &lt;0-100&gt;`, `/traits reset`, TERM_SEP];
    await ctx.reply(`<pre>${lines.join('\n')}</pre>`, { parse_mode: 'HTML' });
  });
}

module.exports = { register };
