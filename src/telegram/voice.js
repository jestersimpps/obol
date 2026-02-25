const { sendHtml } = require('./utils');

const VOICE_LANGUAGES = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-AU', label: 'English (AU)' },
  { code: 'fr-FR', label: 'French' },
  { code: 'de-DE', label: 'German' },
  { code: 'es-ES', label: 'Spanish' },
  { code: 'it-IT', label: 'Italian' },
  { code: 'pt-BR', label: 'Portuguese (BR)' },
  { code: 'nl-NL', label: 'Dutch' },
  { code: 'ja-JP', label: 'Japanese' },
  { code: 'ko-KR', label: 'Korean' },
  { code: 'zh-CN', label: 'Chinese' },
];

const TTS_SAMPLES = {
  'en-US': 'Hello! This is what I sound like. Nice to meet you.',
  'en-GB': 'Hello! This is what I sound like. Lovely to meet you.',
  'en-AU': 'Hello! This is what I sound like. Good to meet you.',
  'fr-FR': 'Bonjour! Voici à quoi ressemble ma voix. Ravie de vous rencontrer.',
  'de-DE': 'Hallo! So klinge ich. Freut mich, Sie kennenzulernen.',
  'es-ES': 'Hola! Así es como suena mi voz. Encantado de conocerte.',
  'it-IT': 'Ciao! Ecco come suona la mia voce. Piacere di conoscerti.',
  'pt-BR': 'Olá! É assim que a minha voz soa. Prazer em conhecê-lo.',
  'nl-NL': 'Hallo! Zo klink ik. Leuk je te ontmoeten.',
  'ja-JP': 'こんにちは！これが私の声です。はじめまして、よろしくお願いします。',
  'ko-KR': '안녕하세요! 제 목소리는 이렇습니다. 만나서 반갑습니다.',
  'zh-CN': '你好！这就是我的声音。很高兴认识你。',
};

const voiceFlowMessages = new Map();

function trackVoiceMsg(userId, chatId, messageId) {
  if (!voiceFlowMessages.has(userId)) voiceFlowMessages.set(userId, []);
  voiceFlowMessages.get(userId).push({ chatId, messageId });
}

async function clearVoiceFlow(userId, bot) {
  const msgs = voiceFlowMessages.get(userId);
  if (!msgs) return;
  voiceFlowMessages.delete(userId);
  for (const { chatId, messageId } of msgs) {
    bot.api.deleteMessage(chatId, messageId).catch(() => {});
  }
}

async function sendVoiceLanguagePicker(ctx) {
  const { InlineKeyboard } = require('grammy');
  const kb = new InlineKeyboard();
  for (const lang of VOICE_LANGUAGES) {
    kb.text(lang.label, `voice:lang:${lang.code}`).row();
  }
  const msg = await ctx.reply('Pick a language:', { reply_markup: kb });
  if (ctx.from) trackVoiceMsg(ctx.from.id, msg.chat.id, msg.message_id);
}

async function handleVoiceCallback(ctx, data, answer, { getTenant, config }) {
  if (!ctx.from) return answer();
  const parts = data.split(':');
  const action = parts[1];

  if (action === 'lang') {
    const langCode = parts[2];
    await answer({ text: langCode });
    const tts = require('../tts');
    try {
      const voices = tts.getVoices(langCode);
      if (voices.length === 0) return sendHtml(ctx, 'No voices found for that language.');
      const { InlineKeyboard } = require('grammy');
      const kb = new InlineKeyboard();
      for (const v of voices) {
        const glyph = v.gender === 'Female' ? '♀' : '♂';
        const shortLabel = v.name.replace('Neural', '').replace('Multilingual', 'ML');
        kb.text(`${glyph} ${shortLabel}`, `voice:pick:${v.name}`).row();
      }
      kb.text('← Back', 'voice:langs').row();
      ctx.editMessageText('Pick a voice:', { reply_markup: kb }).catch(() => {});
    } catch (e) {
      sendHtml(ctx, `Failed to load voices: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (action === 'langs') {
    await answer();
    const { InlineKeyboard } = require('grammy');
    const kb = new InlineKeyboard();
    for (const lang of VOICE_LANGUAGES) {
      kb.text(lang.label, `voice:lang:${lang.code}`).row();
    }
    ctx.editMessageText('Pick a language:', { reply_markup: kb }).catch(() => {});
    return;
  }

  if (action === 'pick') {
    const voiceName = parts[2];
    await answer({ text: `Sampling ${voiceName}...` });
    const tts = require('../tts');
    const fs = require('fs');
    try {
      const langPrefix = voiceName.split('-').slice(0, 2).join('-');
      const sampleText = TTS_SAMPLES[langPrefix] || TTS_SAMPLES['en-US'];
      const filePath = tts.synthesize(sampleText, voiceName);
      const { InputFile } = require('grammy');
      const audioMsg = await ctx.replyWithAudio(new InputFile(filePath));
      try { fs.unlinkSync(filePath); } catch {}
      if (ctx.from) trackVoiceMsg(ctx.from.id, audioMsg.chat.id, audioMsg.message_id);

      const { InlineKeyboard } = require('grammy');
      const kb = new InlineKeyboard();
      kb.text('✓ Use this voice', `voice:save:${voiceName}`).row();
      kb.text('← Try another', `voice:langs`).row();
      const confirmMsg = await ctx.reply(`<b>${voiceName}</b>`, { parse_mode: 'HTML', reply_markup: kb });
      if (ctx.from) trackVoiceMsg(ctx.from.id, confirmMsg.chat.id, confirmMsg.message_id);
    } catch (e) {
      sendHtml(ctx, `Sample failed: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (action === 'save') {
    const voiceName = parts[2];
    await answer({ text: `Voice set: ${voiceName}` });
    const tenant = await getTenant(ctx.from.id, config);
    if (tenant.toolPrefsApi) {
      const pref = tenant.toolPrefs.get('text_to_speech');
      const newConfig = { ...(pref?.config || {}), voice: voiceName };
      await tenant.toolPrefsApi.set('text_to_speech', true, newConfig);
      await tenant.reloadToolPrefs();
    }
    if (ctx.from) await clearVoiceFlow(ctx.from.id, ctx);
    return;
  }

  return answer();
}

module.exports = { clearVoiceFlow, sendVoiceLanguagePicker, handleVoiceCallback };
