import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../src/config', () => ({
  OBOL_DIR: '/tmp/obol-mock-dir',
}));

const {
  isFirstRun,
  markFirstRunComplete,
  parseSetupResponse,
  cleanResponse,
  writePersonalityFromSetup,
} = await import('../src/first-run.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obol-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isFirstRun', () => {
  it('returns true when flag file is missing', () => {
    expect(isFirstRun(tmpDir)).toBe(true);
  });

  it('returns false when flag file exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.first-run-complete'), 'done');
    expect(isFirstRun(tmpDir)).toBe(false);
  });
});

describe('markFirstRunComplete', () => {
  it('writes flag file with ISO date', () => {
    markFirstRunComplete(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.first-run-complete'), 'utf-8');
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('causes isFirstRun to return false', () => {
    expect(isFirstRun(tmpDir)).toBe(true);
    markFirstRunComplete(tmpDir);
    expect(isFirstRun(tmpDir)).toBe(false);
  });
});

describe('parseSetupResponse', () => {
  it('extracts JSON from obol-setup code block', () => {
    const text = 'Hello!\n```obol-setup\n{"soul":"brave","user":"dev","ready":true}\n```\nBye';
    const result = parseSetupResponse(text);
    expect(result).toEqual({ soul: 'brave', user: 'dev', ready: true });
  });

  it('returns null for text without setup block', () => {
    expect(parseSetupResponse('just regular text')).toBeNull();
  });

  it('returns null for invalid JSON in setup block', () => {
    const text = '```obol-setup\n{not valid json}\n```';
    expect(parseSetupResponse(text)).toBeNull();
  });
});

describe('cleanResponse', () => {
  it('strips obol-setup block from text', () => {
    const text = 'Hello!\n```obol-setup\n{"soul":"x"}\n```';
    expect(cleanResponse(text)).toBe('Hello!');
  });

  it('preserves text before and after setup block', () => {
    const text = 'Before\n```obol-setup\n{"a":1}\n```\nAfter';
    expect(cleanResponse(text)).toBe('Before\n\nAfter');
  });
});

describe('writePersonalityFromSetup', () => {
  it('writes SOUL.md and USER.md', () => {
    writePersonalityFromSetup({ soul: '# Soul', user: '# User' }, 'TestBot', tmpDir);
    const soul = fs.readFileSync(path.join(tmpDir, 'personality', 'SOUL.md'), 'utf-8');
    const user = fs.readFileSync(path.join(tmpDir, 'personality', 'USER.md'), 'utf-8');
    expect(soul).toBe('# Soul');
    expect(user).toBe('# User');
  });

  it('creates AGENTS.md with bot name', () => {
    writePersonalityFromSetup({ soul: 'x' }, 'MyBot', tmpDir);
    const agents = fs.readFileSync(path.join(tmpDir, 'personality', 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('MyBot');
  });

  it('does not overwrite existing AGENTS.md', () => {
    const personalityDir = path.join(tmpDir, 'personality');
    fs.mkdirSync(personalityDir, { recursive: true });
    fs.writeFileSync(path.join(personalityDir, 'AGENTS.md'), 'custom content');
    writePersonalityFromSetup({ soul: 'x' }, 'NewBot', tmpDir);
    const agents = fs.readFileSync(path.join(personalityDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toBe('custom content');
  });
});
