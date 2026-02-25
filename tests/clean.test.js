const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;
const fs = require('fs');
const path = require('path');
const os = require('os');

const { cleanWorkspace } = require('../src/clean');

describe('cleanWorkspace', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obol-clean-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty issues for a clean workspace with only allowed dirs and files', async () => {
    for (const dir of ['personality', 'scripts', 'tests', 'commands', 'apps', 'logs']) {
      fs.mkdirSync(path.join(tmpDir, dir));
    }
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, '.evolution-state.json'), '{}');

    const { issues, errors } = await cleanWorkspace(tmpDir);

    expect(issues).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('returns empty for non-existent directory', async () => {
    const { issues, errors } = await cleanWorkspace('/tmp/obol-does-not-exist-' + Date.now());

    expect(issues).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('detects and removes empty rogue directories', async () => {
    fs.mkdirSync(path.join(tmpDir, 'rogue-empty'));

    const { issues, errors } = await cleanWorkspace(tmpDir);

    expect(errors).toEqual([]);
    expect(issues).toContainEqual({
      path: 'rogue-empty/',
      action: 'deleted (empty dir)',
    });
    expect(fs.existsSync(path.join(tmpDir, 'rogue-empty'))).toBe(false);
  });

  it('moves misplaced .js file from root to scripts/', async () => {
    fs.writeFileSync(path.join(tmpDir, 'helper.js'), 'module.exports = {}');

    const { issues, errors } = await cleanWorkspace(tmpDir);

    expect(errors).toEqual([]);
    expect(issues).toContainEqual({
      path: 'helper.js',
      action: 'moved \u2192 scripts/helper.js',
    });
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'helper.js'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'helper.js'))).toBe(false);
  });

  it('moves misplaced .md file from root to commands/', async () => {
    fs.writeFileSync(path.join(tmpDir, 'deploy.md'), '# Deploy');

    const { issues, errors } = await cleanWorkspace(tmpDir);

    expect(errors).toEqual([]);
    expect(issues).toContainEqual({
      path: 'deploy.md',
      action: 'moved \u2192 commands/deploy.md',
    });
    expect(fs.existsSync(path.join(tmpDir, 'commands', 'deploy.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'deploy.md'))).toBe(false);
  });

  it('moves test-*.js file to tests/ via guessDestination test prefix detection', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test-utils.js'), 'const x = 1;');

    const { issues, errors } = await cleanWorkspace(tmpDir);

    expect(errors).toEqual([]);
    expect(issues).toContainEqual({
      path: 'test-utils.js',
      action: 'moved \u2192 tests/test-utils.js',
    });
    expect(fs.existsSync(path.join(tmpDir, 'tests', 'test-utils.js'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'test-utils.js'))).toBe(false);
  });

  it('preserves allowed files at root', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, '.evolution-state.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, '.first-run-done'), '');
    fs.writeFileSync(path.join(tmpDir, '.post-setup-done'), '');
    fs.writeFileSync(path.join(tmpDir, '.some-dotfile'), '');

    const { issues, errors } = await cleanWorkspace(tmpDir);

    expect(issues).toEqual([]);
    expect(errors).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.evolution-state.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.first-run-done'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.post-setup-done'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.some-dotfile'))).toBe(true);
  });

  it('preserves allowed directories', async () => {
    const allowedDirs = ['personality', 'scripts', 'tests', 'commands', 'apps', 'logs'];
    for (const dir of allowedDirs) {
      fs.mkdirSync(path.join(tmpDir, dir));
    }

    const { issues, errors } = await cleanWorkspace(tmpDir);

    expect(issues).toEqual([]);
    expect(errors).toEqual([]);
    for (const dir of allowedDirs) {
      expect(fs.existsSync(path.join(tmpDir, dir))).toBe(true);
    }
  });
});
