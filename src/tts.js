const path = require('path');
const { execSync } = require('child_process');

async function synthesize(text, voice = 'en-US-JennyNeural', options = {}) {
  const { EdgeTTS } = await import('@andresaya/edge-tts');
  const tts = new EdgeTTS();

  const synthOpts = {};
  if (options.rate) synthOpts.rate = `${options.rate > 0 ? '+' : ''}${options.rate}%`;
  if (options.pitch) synthOpts.pitch = `${options.pitch > 0 ? '+' : ''}${options.pitch}Hz`;

  await tts.synthesize(text, voice, synthOpts);
  const basePath = `/tmp/tts-${Date.now()}`;
  const mp3Path = await tts.toFile(basePath);

  try {
    const oggPath = `${basePath}.ogg`;
    execSync(`ffmpeg -i "${mp3Path}" -c:a libopus -b:a 64k "${oggPath}" -y`, {
      timeout: 30000,
      stdio: 'pipe',
    });
    require('fs').unlinkSync(mp3Path);
    return oggPath;
  } catch {
    return mp3Path;
  }
}

async function getVoices(language, gender) {
  const { EdgeTTS } = await import('@andresaya/edge-tts');
  const tts = new EdgeTTS();

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
