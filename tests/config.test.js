import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const REAL_HOME = os.homedir();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'obol-test-'));
const OBOL_DIR = path.join(tmpRoot, '.obol');
const USERS_DIR = path.join(OBOL_DIR, 'users');
const CONFIG_FILE = path.join(OBOL_DIR, 'config.json');

async function loadConfigModule() {
  vi.resetModules();
  process.env.HOME = tmpRoot;
  const mod = await import('../src/config.js');
  process.env.HOME = REAL_HOME;
  return mod;
}

let config;

describe('config', () => {
  beforeEach(async () => {
    config = await loadConfigModule();
  });

  afterEach(() => {
    if (fs.existsSync(OBOL_DIR)) {
      fs.rmSync(OBOL_DIR, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  describe('constants', () => {
    it('OBOL_DIR points to <home>/.obol', () => {
      expect(config.OBOL_DIR).toBe(OBOL_DIR);
    });

    it('USERS_DIR points to <home>/.obol/users', () => {
      expect(config.USERS_DIR).toBe(USERS_DIR);
    });

    it('CONFIG_FILE points to <home>/.obol/config.json', () => {
      expect(config.CONFIG_FILE).toBe(CONFIG_FILE);
    });

    it('PID_FILE points to <home>/.obol/obol.pid', () => {
      expect(config.PID_FILE).toBe(path.join(OBOL_DIR, 'obol.pid'));
    });

    it('LOG_FILE points to <home>/.obol/logs/obol.log', () => {
      expect(config.LOG_FILE).toBe(path.join(OBOL_DIR, 'logs', 'obol.log'));
    });
  });

  describe('getConfigDir', () => {
    it('returns OBOL_DIR', () => {
      expect(config.getConfigDir()).toBe(config.OBOL_DIR);
    });
  });

  describe('getUserDir', () => {
    it('returns users/<id> path for numeric id', () => {
      expect(config.getUserDir(12345)).toBe(path.join(USERS_DIR, '12345'));
    });

    it('returns users/<id> path for string id', () => {
      expect(config.getUserDir('abc')).toBe(path.join(USERS_DIR, 'abc'));
    });

    it('converts numeric id to string', () => {
      const result = config.getUserDir(99);
      expect(result.endsWith('99')).toBe(true);
    });
  });

  describe('loadConfig', () => {
    it('returns null when config file does not exist', () => {
      expect(config.loadConfig()).toBeNull();
    });

    it('returns parsed JSON when config exists', () => {
      const data = { apiKey: 'test-key', model: 'claude-3' };
      fs.mkdirSync(OBOL_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(data));
      expect(config.loadConfig()).toEqual(data);
    });

    it('returns null on invalid JSON', () => {
      fs.mkdirSync(OBOL_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, 'not-json{{{');
      expect(config.loadConfig()).toBeNull();
    });

    it('skips pass resolution when resolve is false', () => {
      const data = { apiKey: 'pass:obol/api-key' };
      fs.mkdirSync(OBOL_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(data));
      const result = config.loadConfig({ resolve: false });
      expect(result.apiKey).toBe('pass:obol/api-key');
    });

    it('keeps pass: placeholder when pass command not available', () => {
      const data = { apiKey: 'pass:nonexistent/key' };
      fs.mkdirSync(OBOL_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(data));
      const result = config.loadConfig();
      expect(result.apiKey).toBe('pass:nonexistent/key');
    });

    it('preserves non-pass values unchanged', () => {
      const data = { nested: { secret: 'plain-value' }, arr: [1, 2] };
      fs.mkdirSync(OBOL_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(data));
      const result = config.loadConfig();
      expect(result.nested.secret).toBe('plain-value');
      expect(result.arr).toEqual([1, 2]);
    });
  });

  describe('saveConfig', () => {
    it('creates OBOL_DIR and writes config file', () => {
      const data = { key: 'value' };
      config.saveConfig(data);
      expect(fs.existsSync(OBOL_DIR)).toBe(true);
      const written = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      expect(written).toEqual(data);
    });

    it('writes formatted JSON', () => {
      const data = { key: 'value' };
      config.saveConfig(data);
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      expect(raw).toBe(JSON.stringify(data, null, 2));
    });

    it('sets restrictive file permissions', () => {
      config.saveConfig({ key: 'value' });
      const stats = fs.statSync(CONFIG_FILE);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('ensureUserDir', () => {
    it('creates all subdirectories', () => {
      config.ensureUserDir('42');
      const expectedSubs = ['personality', 'scripts', 'tests', 'commands', 'apps', 'logs'];
      for (const sub of expectedSubs) {
        expect(fs.existsSync(path.join(USERS_DIR, '42', sub))).toBe(true);
      }
    });

    it('returns the user directory path', () => {
      const result = config.ensureUserDir('42');
      expect(result).toBe(path.join(USERS_DIR, '42'));
    });

    it('is idempotent', () => {
      config.ensureUserDir('42');
      config.ensureUserDir('42');
      expect(fs.existsSync(path.join(USERS_DIR, '42'))).toBe(true);
    });
  });

  describe('listUsers', () => {
    it('returns empty array when USERS_DIR does not exist', () => {
      expect(config.listUsers()).toEqual([]);
    });

    it('returns directory names inside USERS_DIR', () => {
      config.ensureUserDir('111');
      config.ensureUserDir('222');
      fs.writeFileSync(path.join(USERS_DIR, 'notes.txt'), 'ignore me');
      const result = config.listUsers();
      expect(result.sort()).toEqual(['111', '222']);
    });

    it('returns empty array when USERS_DIR is empty', () => {
      fs.mkdirSync(USERS_DIR, { recursive: true });
      expect(config.listUsers()).toEqual([]);
    });
  });

  describe('saveConfig and loadConfig roundtrip', () => {
    it('saves and loads config correctly', () => {
      const data = { apiKey: 'test-123', telegram: { token: 'tg-456' } };
      config.saveConfig(data);
      const loaded = config.loadConfig({ resolve: false });
      expect(loaded).toEqual(data);
    });
  });
});
