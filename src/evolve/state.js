const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('../config');

function evolutionStatePath(userDir) {
  return path.join(userDir || OBOL_DIR, '.evolution-state.json');
}

function loadEvolutionState(userDir) {
  try {
    return JSON.parse(fs.readFileSync(evolutionStatePath(userDir), 'utf-8'));
  } catch {
    return { evolutionCount: 0, lastEvolution: null };
  }
}

function saveEvolutionState(state, userDir) {
  fs.writeFileSync(evolutionStatePath(userDir), JSON.stringify(state, null, 2));
}

module.exports = { loadEvolutionState, saveEvolutionState };
