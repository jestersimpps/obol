const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('./config');

function loadPersonality(dir) {
  dir = dir || path.join(OBOL_DIR, 'personality');
  const personality = {};

  const files = {
    soul: 'SOUL.md',
    user: 'USER.md',
    agents: 'AGENTS.md',
  };

  for (const [key, filename] of Object.entries(files)) {
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
