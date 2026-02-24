let _EdgeTTS = null;

async function getEdgeTTS() {
  if (!_EdgeTTS) {
    const mod = await import('@andresaya/edge-tts');
    _EdgeTTS = mod.EdgeTTS;
  }
  return new _EdgeTTS();
}

async function synthesize(text, voice = 'en-US-JennyNeural', options = {}) {
  const tts = await getEdgeTTS();

  const synthOpts = {};
  if (options.rate) synthOpts.rate = `${options.rate > 0 ? '+' : ''}${options.rate}%`;
  if (options.pitch) synthOpts.pitch = `${options.pitch > 0 ? '+' : ''}${options.pitch}Hz`;

  await tts.synthesize(text, voice, synthOpts);
  const mp3Path = await tts.toFile(`/tmp/tts-${Date.now()}`);
  return mp3Path;
}

async function getVoices(language, gender) {
  const tts = await getEdgeTTS();

  let voices;
  if (language) {
    voices = await tts.getVoicesByLanguage(language);
  } else {
    voices = await tts.getVoices();
  }

  if (gender) {
    const g = gender.toLowerCase();
    voices = voices.filter(v => v.Gender?.toLowerCase() === g);
  }

  return voices.map(v => ({ name: v.ShortName, locale: v.Locale, gender: v.Gender }));
}

module.exports = { synthesize, getVoices };
