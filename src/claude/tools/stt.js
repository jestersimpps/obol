const definitions = [
  {
    name: 'transcribe_audio',
    description: 'Transcribe an audio or voice file to text using Whisper. Use this to convert voice messages or audio files to text.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the audio file to transcribe' },
      },
      required: ['path'],
    },
  },
];

const handlers = {
  async transcribe_audio(input) {
    const { transcribe } = require('../../stt');
    const text = await transcribe(input.path);
    if (!text) return 'Transcription failed or returned empty result.';
    return text;
  },
};

module.exports = { definitions, handlers };
