const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;
const path = require('path');
const fs = require('fs');
const os = require('os');

const configModule = require('../src/config');

const { loadEvolutionState, shouldEvolve, tickExchange, runTests } = require('../src/evolve');

describe('evolve', () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obol-evolve-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadEvolutionState', () => {
    it('returns defaults when no file exists', () => {
      const state = loadEvolutionState(tmpDir);
      expect(state).toEqual({
        exchangesSinceLastEvolution: 0,
        evolutionCount: 0,
        lastEvolution: null,
      });
    });

    it('parses existing state file', () => {
      const saved = {
        exchangesSinceLastEvolution: 42,
        evolutionCount: 3,
        lastEvolution: '2025-01-01T00:00:00.000Z',
      };
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify(saved),
      );

      const state = loadEvolutionState(tmpDir);
      expect(state).toEqual(saved);
    });

    it('returns defaults when file contains invalid JSON', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        'not-json{{{',
      );

      const state = loadEvolutionState(tmpDir);
      expect(state).toEqual({
        exchangesSinceLastEvolution: 0,
        evolutionCount: 0,
        lastEvolution: null,
      });
    });
  });

  describe('tickExchange', () => {
    it('increments counter from zero', async () => {
      const count = await tickExchange(tmpDir);
      expect(count).toBe(1);
    });

    it('returns the new count', async () => {
      await tickExchange(tmpDir);
      const count = await tickExchange(tmpDir);
      expect(count).toBe(2);
    });

    it('persists state to disk', async () => {
      await tickExchange(tmpDir);
      await tickExchange(tmpDir);
      await tickExchange(tmpDir);

      const raw = fs.readFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        'utf-8',
      );
      const state = JSON.parse(raw);
      expect(state.exchangesSinceLastEvolution).toBe(3);
    });

    it('preserves other state fields', async () => {
      const initial = {
        exchangesSinceLastEvolution: 10,
        evolutionCount: 5,
        lastEvolution: '2025-06-01T00:00:00.000Z',
      };
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify(initial),
      );

      await tickExchange(tmpDir);

      const raw = fs.readFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        'utf-8',
      );
      const state = JSON.parse(raw);
      expect(state.exchangesSinceLastEvolution).toBe(11);
      expect(state.evolutionCount).toBe(5);
      expect(state.lastEvolution).toBe('2025-06-01T00:00:00.000Z');
    });
  });

  describe('shouldEvolve', () => {
    it('returns false when under default threshold', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(null);
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ exchangesSinceLastEvolution: 99, evolutionCount: 0, lastEvolution: null }),
      );

      const result = await shouldEvolve(tmpDir);
      expect(result).toBe(false);
    });

    it('returns true when at default threshold', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(null);
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ exchangesSinceLastEvolution: 100, evolutionCount: 0, lastEvolution: null }),
      );

      const result = await shouldEvolve(tmpDir);
      expect(result).toBe(true);
    });

    it('returns true when above default threshold', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(null);
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ exchangesSinceLastEvolution: 150, evolutionCount: 0, lastEvolution: null }),
      );

      const result = await shouldEvolve(tmpDir);
      expect(result).toBe(true);
    });

    it('uses custom threshold from config', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue({ evolution: { exchanges: 10 } });
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ exchangesSinceLastEvolution: 10, evolutionCount: 0, lastEvolution: null }),
      );

      const result = await shouldEvolve(tmpDir);
      expect(result).toBe(true);
    });

    it('returns false when under custom threshold', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue({ evolution: { exchanges: 50 } });
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ exchangesSinceLastEvolution: 49, evolutionCount: 0, lastEvolution: null }),
      );

      const result = await shouldEvolve(tmpDir);
      expect(result).toBe(false);
    });

    it('returns false when no state file exists (0 exchanges)', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(null);
      const result = await shouldEvolve(tmpDir);
      expect(result).toBe(false);
    });
  });

  describe('runTests', () => {
    it('returns zero counts when directory does not exist', () => {
      const result = runTests(path.join(tmpDir, 'nonexistent'));
      expect(result).toEqual({ passed: 0, failed: 0, total: 0, output: 'no tests' });
    });

    it('returns zero counts when directory exists but has no test files', () => {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir);
      fs.writeFileSync(path.join(testsDir, 'readme.md'), 'not a test');

      const result = runTests(testsDir);
      expect(result).toEqual({ passed: 0, failed: 0, total: 0, output: 'no test files' });
    });

    it('returns zero counts when directory is empty', () => {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir);

      const result = runTests(testsDir);
      expect(result).toEqual({ passed: 0, failed: 0, total: 0, output: 'no test files' });
    });

    it('counts passing .js test file', () => {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir);
      fs.writeFileSync(path.join(testsDir, 'test-pass.js'), 'process.exit(0);');

      const result = runTests(testsDir);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.total).toBe(1);
    });

    it('counts failing .js test file', () => {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir);
      fs.writeFileSync(path.join(testsDir, 'test-fail.js'), 'process.exit(1);');

      const result = runTests(testsDir);
      expect(result.passed).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.total).toBe(1);
    });

    it('counts mix of passing and failing tests', () => {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir);
      fs.writeFileSync(path.join(testsDir, 'test-pass.js'), 'process.exit(0);');
      fs.writeFileSync(path.join(testsDir, 'test-fail.js'), 'process.exit(1);');

      const result = runTests(testsDir);
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.total).toBe(2);
    });

    it('includes output lines for each test', () => {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir);
      fs.writeFileSync(path.join(testsDir, 'test-ok.js'), 'process.exit(0);');

      const result = runTests(testsDir);
      expect(result.output).toContain('test-ok.js');
      expect(result.output).toContain('passed');
    });
  });
});
