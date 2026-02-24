const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;
const path = require('path');
const fs = require('fs');
const os = require('os');

const configModule = require('../src/config');

const { loadEvolutionState, checkEvolution, runTests } = require('../src/evolve');

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

  describe('checkEvolution', () => {
    const mockMessageLog = (rows) => ({
      url: 'https://test.supabase.co',
      headers: { apikey: 'test', Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      userId: 123,
      _fetch: rows,
    });

    beforeEach(() => {
      global._originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = global._originalFetch;
    });

    it('returns false when time not elapsed', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(null);
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ evolutionCount: 1, lastEvolution: new Date().toISOString() }),
      );

      const result = await checkEvolution(tmpDir, mockMessageLog([]));
      expect(result.ready).toBe(false);
    });

    it('returns false when no messageLog provided', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(null);
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ evolutionCount: 1, lastEvolution: '2025-01-01T00:00:00.000Z' }),
      );

      const result = await checkEvolution(tmpDir, null);
      expect(result.ready).toBe(false);
    });

    it('returns true when time elapsed and DB has enough messages', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(null);
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ evolutionCount: 1, lastEvolution: '2025-01-01T00:00:00.000Z' }),
      );

      const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      global.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve(rows) });

      const result = await checkEvolution(tmpDir, mockMessageLog(rows));
      expect(result.ready).toBe(true);
    });

    it('returns false when time elapsed but not enough messages in DB', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(null);
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ evolutionCount: 1, lastEvolution: '2025-01-01T00:00:00.000Z' }),
      );

      global.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve([{ id: 1 }]) });

      const result = await checkEvolution(tmpDir, mockMessageLog([{ id: 1 }]));
      expect(result.ready).toBe(false);
    });

    it('returns true on first run (no lastEvolution) with enough messages', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue(null);

      const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      global.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve(rows) });

      const result = await checkEvolution(tmpDir, mockMessageLog(rows));
      expect(result.ready).toBe(true);
    });

    it('uses custom intervalHours from config', async () => {
      vi.spyOn(configModule, 'loadConfig').mockReturnValue({ evolution: { intervalHours: 48 } });
      const recentTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(
        path.join(tmpDir, '.evolution-state.json'),
        JSON.stringify({ evolutionCount: 1, lastEvolution: recentTime }),
      );

      const result = await checkEvolution(tmpDir, mockMessageLog([]));
      expect(result.ready).toBe(false);
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
