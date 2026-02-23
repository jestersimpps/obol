import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../src/config', () => ({
  OBOL_DIR: '/tmp/obol-mock-dir',
  loadConfig: vi.fn(() => ({})),
  saveConfig: vi.fn(),
}));

const { isPostSetupDone, runPostSetup, SETUP_TASKS } = await import('../src/post-setup.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obol-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isPostSetupDone', () => {
  it('returns false when flag is missing', () => {
    expect(isPostSetupDone(tmpDir)).toBe(false);
  });

  it('returns true when flag exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.post-setup-complete'), '{}');
    expect(isPostSetupDone(tmpDir)).toBe(true);
  });
});

describe('SETUP_TASKS', () => {
  it('is an array with 9 elements', () => {
    expect(Array.isArray(SETUP_TASKS)).toBe(true);
    expect(SETUP_TASKS).toHaveLength(9);
  });

  it('each task has name, description, run properties', () => {
    for (const task of SETUP_TASKS) {
      expect(task).toHaveProperty('name');
      expect(task).toHaveProperty('description');
      expect(task).toHaveProperty('run');
    }
  });

  it('each task.run is a function', () => {
    for (const task of SETUP_TASKS) {
      expect(typeof task.run).toBe('function');
    }
  });
});

describe('runPostSetup', () => {
  it('returns early when already done', async () => {
    fs.writeFileSync(path.join(tmpDir, '.post-setup-complete'), '{}');
    const reportFn = vi.fn();
    const result = await runPostSetup({}, reportFn, tmpDir);
    expect(result).toBeUndefined();
    expect(reportFn).not.toHaveBeenCalled();
  });

  it('skips on non-linux and calls reportFn with skip message', async () => {
    const reportFn = vi.fn();
    const result = await runPostSetup({}, reportFn, tmpDir);
    expect(reportFn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping on')
    );
    expect(result).toEqual([]);
    expect(isPostSetupDone(tmpDir)).toBe(true);
  });
});
