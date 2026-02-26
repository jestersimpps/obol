const { loadEvolutionState } = require('./state');

/**
 * Returns true if evolution hasn't run yet today in the given timezone.
 * @param {string} userDir
 * @param {string} timezone
 * @returns {boolean}
 */
function shouldEvolveNow(userDir, timezone = 'UTC') {
  const state = loadEvolutionState(userDir);
  if (!state.lastEvolution) return true;

  const tz = timezone || 'UTC';
  const lastDate = new Date(state.lastEvolution).toLocaleDateString('en-CA', { timeZone: tz });
  const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: tz });

  return lastDate !== todayDate;
}

module.exports = { shouldEvolveNow };
