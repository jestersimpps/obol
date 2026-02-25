const { checkEvolution } = require('./check');
const { evolve } = require('./evolve');
const { runTests } = require('./tests');
const { loadEvolutionState } = require('./state');

module.exports = { checkEvolution, evolve, runTests, loadEvolutionState };
