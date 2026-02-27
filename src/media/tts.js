const { execSync } = require('child_process');

let _installed = null;

function ensureInstalled() {
  if (_installed) return;
  try {
    execSync('edge-tts --version', { stdio: 'pipe', timeout: 5000 });
    _installed = true;
  } catch {
    console.log('[tts] Installing edge-tts...');
    execSync('pip3 install edge-tts', { stdio: 'pipe', timeout: 60000 });
    _installed = true;
  }
}

function synthesize(text, voice = 'en-US-JennyNeural', options = {}) {
  ensureInstalled();

  const outPath = `/tmp/tts-${Date.now()}.mp3`;
  const args = ['edge-tts', '--voice', voice, '--write-media', outPath];

  if (options.rate) args.push('--rate', `${options.rate > 0 ? '+' : ''}${options.rate}%`);
  if (options.pitch) args.push('--pitch', `${options.pitch > 0 ? '+' : ''}${options.pitch}Hz`);

  args.push('--text', text);

  execSync(args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' '), {
    stdio: 'pipe',
    timeout: 30000,
  });

  return outPath;
}

function getVoices(language, gender) {
  ensureInstalled();

  const raw = execSync('edge-tts --list-voices', { encoding: 'utf-8', timeout: 15000 });
  const lines = raw.trim().split('\n').slice(2);

  let voices = lines.map(line => {
    const cols = line.split(/\s{2,}/);
    return { name: cols[0], gender: cols[1], locale: cols[0]?.split('-').slice(0, 2).join('-') };
  }).filter(v => v.name);

  if (language) {
    const lang = language.toLowerCase();
    voices = voices.filter(v => v.name.toLowerCase().startsWith(lang));
  }
  if (gender) {
    const g = gender.toLowerCase();
    voices = voices.filter(v => v.gender?.toLowerCase() === g);
  }

  return voices;
}

module.exports = { synthesize, getVoices };
