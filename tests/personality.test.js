const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;
const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadPersonality } = require('../src/personality');

describe('loadPersonality', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obol-personality-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns all three files when present', () => {
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), 'soul content');
    fs.writeFileSync(path.join(tmpDir, 'USER.md'), 'user content');
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'agents content');

    const result = loadPersonality(tmpDir);

    expect(result.soul).toBe('soul content');
    expect(result.user).toBe('user content');
    expect(result.agents).toBe('agents content');
  });

  it('returns null for missing files', () => {
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), 'only soul');

    const result = loadPersonality(tmpDir);

    expect(result.soul).toBe('only soul');
    expect(result.user).toBeNull();
    expect(result.agents).toBeNull();
  });

  it('returns object with soul, user, agents keys', () => {
    const result = loadPersonality(tmpDir);

    expect(result).toHaveProperty('soul');
    expect(result).toHaveProperty('user');
    expect(result).toHaveProperty('agents');
  });
});
