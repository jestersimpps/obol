const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;
const path = require('path');
const fs = require('fs');
const os = require('os');

const configModule = require('../src/config');

const { loadEvolutionState, shouldEvolveNow, runTests } = require('../src/evolve');

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
        evolutionCount: 0,
        lastEvolution: null,
      });
    });

    it('parses existing state file', () => {
      const saved = {
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
        evolutionCount: 0,
        lastEvolution: null,
      });
    });
  });

  describe('shouldEvolveNow', () => {
    it('returns true when no lastEvolution (never run)', () => {
      const result = shouldEvolveNow(tmpDir, 'UTC');
      expect(result).toBe(true);
    });

    it('returns false when lastEvolution was today', () => {
      const today = new Date().toISOString();
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ evolutionCount: 1, lastEvolution: today }),
      );

      const result = shouldEvolveNow(tmpDir, 'UTC');
      expect(result).toBe(false);
    });

    it('returns true when lastEvolution was yesterday', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ evolutionCount: 1, lastEvolution: yesterday }),
      );

      const result = shouldEvolveNow(tmpDir, 'UTC');
      expect(result).toBe(true);
    });

    it('defaults to UTC when no timezone provided', () => {
      const result = shouldEvolveNow(tmpDir);
      expect(result).toBe(true);
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
