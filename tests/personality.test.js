const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;
const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadPersonality } = require('../src/personality');

describe('loadPersonality', () => {
  let sharedDir;
  let userDir;

  beforeEach(() => {
    sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obol-shared-'));
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obol-user-'));
  });

  afterEach(() => {
    fs.rmSync(sharedDir, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  it('loads SOUL.md from sharedDir', () => {
    fs.writeFileSync(path.join(sharedDir, 'SOUL.md'), 'shared soul');

    const result = loadPersonality(sharedDir, userDir);

    expect(result.soul).toBe('shared soul');
  });

  it('loads AGENTS.md from userDir', () => {
    fs.writeFileSync(path.join(userDir, 'AGENTS.md'), 'user agents');

    const result = loadPersonality(sharedDir, userDir);

    expect(result.agents).toBe('user agents');
  });

  it('loads USER.md from userDir', () => {
    fs.writeFileSync(path.join(userDir, 'USER.md'), 'user content');

    const result = loadPersonality(sharedDir, userDir);

    expect(result.user).toBe('user content');
  });

  it('does not use sharedDir AGENTS.md when userDir has its own', () => {
    fs.writeFileSync(path.join(sharedDir, 'AGENTS.md'), 'shared agents');
    fs.writeFileSync(path.join(userDir, 'AGENTS.md'), 'user agents');

    const result = loadPersonality(sharedDir, userDir);

    expect(result.agents).toBe('user agents');
  });

  it('returns null for soul when SOUL.md is missing from sharedDir', () => {
    const result = loadPersonality(sharedDir, userDir);
    expect(result.soul).toBeNull();
  });

  it('returns null for agents when AGENTS.md is missing from userDir', () => {
    const result = loadPersonality(sharedDir, userDir);
    expect(result.agents).toBeNull();
  });

  it('returns all three keys', () => {
    const result = loadPersonality(sharedDir, userDir);
    expect(result).toHaveProperty('soul');
    expect(result).toHaveProperty('user');
    expect(result).toHaveProperty('agents');
  });

  it('falls back to sharedDir when userDir is not provided', () => {
    fs.writeFileSync(path.join(sharedDir, 'SOUL.md'), 'soul');
    fs.writeFileSync(path.join(sharedDir, 'AGENTS.md'), 'agents');
    fs.writeFileSync(path.join(sharedDir, 'USER.md'), 'user');

    const result = loadPersonality(sharedDir);

    expect(result.soul).toBe('soul');
    expect(result.agents).toBe('agents');
    expect(result.user).toBe('user');
  });
});
