const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('../config');

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

  return personality;
}

module.exports = { loadPersonality };
