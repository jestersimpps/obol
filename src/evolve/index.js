const { shouldEvolveNow } = require('./check');
const { evolve } = require('./evolve');
const { runTests } = require('./tests');
const { loadEvolutionState } = require('./state');

module.exports = { shouldEvolveNow, evolve, runTests, loadEvolutionState };
