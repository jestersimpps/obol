const fs = require('fs');

const definitions = [
  {
    name: 'text_to_speech',
    description: 'Convert text to speech and send as a voice message. Use when the user wants something read aloud.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to synthesize into speech' },
        voice: { type: 'string', description: 'Voice name override (e.g. en-US-GuyNeural). Uses user preference if not specified.' },
        rate: { type: 'number', description: 'Speech rate adjustment in percent (e.g. -10 for slower, 10 for faster)' },
        pitch: { type: 'number', description: 'Pitch adjustment in Hz (e.g. -5 for lower, 5 for higher)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'tts_voices',
    description: 'List available text-to-speech voices. Use to help the user pick a voice.',
    input_schema: {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'Language filter (e.g. en, en-US, fr, de)' },
        gender: { type: 'string', enum: ['Male', 'Female'], description: 'Gender filter' },
      },
    },
  },
];

const handlers = {
  async text_to_speech(input, memory, context) {
    const tts = require('../../tts');
    const telegramCtx = context.ctx;
    if (!telegramCtx) return 'Cannot send voice messages in this context.';
    const toolPrefs = context.toolPrefs;
    const ttsConfig = toolPrefs?.get('text_to_speech')?.config || {};
    const voice = input.voice || ttsConfig.voice || 'en-US-JennyNeural';
    const filePath = tts.synthesize(input.text, voice, {
      rate: input.rate || ttsConfig.rate,
      pitch: input.pitch || ttsConfig.pitch,
    });
    try {
      const { InputFile } = require('grammy');
      await telegramCtx.replyWithAudio(new InputFile(filePath));
      return `Voice message sent (voice: ${voice})`;
    } finally {
      try { fs.unlinkSync(filePath); } catch {}
    }
  },

  async tts_voices(input) {
    const tts = require('../../tts');
    const voices = tts.getVoices(input.language, input.gender);
    if (voices.length === 0) return 'No voices found matching that filter.';
    return JSON.stringify(voices.slice(0, 30));
  },
};

module.exports = { definitions, handlers };
