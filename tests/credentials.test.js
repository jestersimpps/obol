import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Use a temp directory for all secrets in this test suite.
// We set OBOL_NO_PASS=1 and OBOL_USERS_DIR to point at the temp dir
// so credentials.js uses JSON fallback and writes to an isolated location.
// This avoids the CJS/ESM mock boundary issue with child_process interception.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'obol-cred-test-'));
const USERS_DIR = path.join(tmpRoot, 'users');

let credentials;

async function loadModule() {
  vi.resetModules();
  const mod = await import('../src/credentials.js');
  return mod;
}

describe('credentials', () => {
  beforeEach(async () => {
    // Isolate each test: fresh temp users dir + force JSON fallback
    fs.mkdirSync(path.join(USERS_DIR, '123'), { recursive: true });
    process.env.OBOL_NO_PASS = '1';
    process.env.OBOL_USERS_DIR = USERS_DIR;
    credentials = await loadModule();
  });

  afterEach(() => {
    delete process.env.OBOL_NO_PASS;
    delete process.env.OBOL_USERS_DIR;
    // Clean up secrets written during the test
    const userDir = path.join(USERS_DIR, '123');
    const secretsFile = path.join(userDir, 'secrets.json');
    if (fs.existsSync(secretsFile)) fs.unlinkSync(secretsFile);
    const userDir456 = path.join(USERS_DIR, '456');
    if (fs.existsSync(userDir456)) {
      fs.rmSync(userDir456, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  describe('validateKey', () => {
    it('accepts valid keys', () => {
      expect(() => credentials.validateKey('gmail-password')).not.toThrow();
      expect(() => credentials.validateKey('api.key')).not.toThrow();
      expect(() => credentials.validateKey('my_token_123')).not.toThrow();
    });

    it('rejects empty key', () => {
      expect(() => credentials.validateKey('')).toThrow('Key is required');
      expect(() => credentials.validateKey(null)).toThrow('Key is required');
    });

    it('rejects invalid characters', () => {
      expect(() => credentials.validateKey('key/path')).toThrow();
      expect(() => credentials.validateKey('../escape')).toThrow();
      expect(() => credentials.validateKey('has space')).toThrow();
    });

    it('rejects keys starting with special chars', () => {
      expect(() => credentials.validateKey('-starts-dash')).toThrow();
      expect(() => credentials.validateKey('.starts-dot')).toThrow();
    });

    it('rejects keys over 64 chars', () => {
      expect(() => credentials.validateKey('a'.repeat(65))).toThrow();
    });

    it('accepts keys at max length', () => {
      expect(() => credentials.validateKey('a'.repeat(64))).not.toThrow();
    });
  });

  describe('JSON fallback (no pass)', () => {
    it('stores and reads a secret', () => {
      credentials.storeSecret('123', 'test-key', 'test-value');
      expect(credentials.readSecret('123', 'test-key')).toBe('test-value');
    });

    it('returns null for missing secret', () => {
      expect(credentials.readSecret('123', 'nonexistent')).toBeNull();
    });

    it('lists stored keys', () => {
      credentials.storeSecret('123', 'alpha', 'val1');
      credentials.storeSecret('123', 'beta', 'val2');
      const keys = credentials.listSecrets('123');
      expect(keys.sort()).toEqual(['alpha', 'beta']);
    });

    it('lists empty when no secrets', () => {
      expect(credentials.listSecrets('123')).toEqual([]);
    });

    it('removes a secret', () => {
      credentials.storeSecret('123', 'to-remove', 'val');
      credentials.removeSecret('123', 'to-remove');
      expect(credentials.readSecret('123', 'to-remove')).toBeNull();
    });

    it('overwrites existing secret', () => {
      credentials.storeSecret('123', 'key', 'old');
      credentials.storeSecret('123', 'key', 'new');
      expect(credentials.readSecret('123', 'key')).toBe('new');
    });

    it('sets 0o600 permissions on secrets file', () => {
      credentials.storeSecret('123', 'perms-test', 'val');
      const p = path.join(USERS_DIR, '123', 'secrets.json');
      const stats = fs.statSync(p);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('isolates secrets per user', () => {
      fs.mkdirSync(path.join(USERS_DIR, '456'), { recursive: true });
      credentials.storeSecret('123', 'shared-key', 'user1-val');
      credentials.storeSecret('456', 'shared-key', 'user2-val');
      expect(credentials.readSecret('123', 'shared-key')).toBe('user1-val');
      expect(credentials.readSecret('456', 'shared-key')).toBe('user2-val');
    });

    it('rejects empty value', () => {
      expect(() => credentials.storeSecret('123', 'key', '')).toThrow('Value is required');
    });
  });

  describe('hasPassStore', () => {
    it('returns false when OBOL_NO_PASS=1', () => {
      // OBOL_NO_PASS is set in beforeEach — this confirms the env var controls the behaviour
      expect(credentials.hasPassStore()).toBe(false);
    });
  });
});
