const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('./config');

const DEFAULT_TRAITS = require('./defaults/traits.json');

function loadPersonality(sharedDir, userDir) {
  sharedDir = sharedDir || path.join(OBOL_DIR, 'personality');
  userDir = userDir || sharedDir;
  const personality = {};

  for (const [key, filename, dir] of [
    ['soul', 'SOUL.md', sharedDir],
    ['agents', 'AGENTS.md', userDir],
    ['user', 'USER.md', userDir],
  ]) {
    const filepath = path.join(dir, filename);
    try {
      personality[key] = fs.readFileSync(filepath, 'utf-8');
    } catch {
      personality[key] = null;
    }
  }

  personality.traits = loadTraits(userDir);

  return personality;
}

function loadTraits(dir) {
  dir = dir || path.join(OBOL_DIR, 'personality');
  const traitsPath = path.join(dir, 'traits.json');
  try {
    return JSON.parse(fs.readFileSync(traitsPath, 'utf-8'));
  } catch {
    return { ...DEFAULT_TRAITS };
  }
}

function saveTraits(dir, traits) {
  dir = dir || path.join(OBOL_DIR, 'personality');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'traits.json'), JSON.stringify(traits, null, 2));
}

module.exports = { loadPersonality, loadTraits, saveTraits, DEFAULT_TRAITS };
