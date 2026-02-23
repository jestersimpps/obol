import { describe, it, expect } from 'vitest';
import path from 'path';

const { isValidNpmPackage, isPathInsideDir, isAllowedUrl, execAsync } = await import('../src/sanitize.js');

describe('isValidNpmPackage', () => {
  it('accepts valid package names', () => {
    expect(isValidNpmPackage('express')).toBe(true);
    expect(isValidNpmPackage('lodash')).toBe(true);
    expect(isValidNpmPackage('@types/node')).toBe(true);
    expect(isValidNpmPackage('my-package@1.2.3')).toBe(true);
    expect(isValidNpmPackage('@scope/pkg@^2.0.0')).toBe(true);
  });

  it('rejects injection attempts', () => {
    expect(isValidNpmPackage('express && rm -rf /')).toBe(false);
    expect(isValidNpmPackage('$(whoami)')).toBe(false);
    expect(isValidNpmPackage('pkg; echo hacked')).toBe(false);
    expect(isValidNpmPackage('`curl evil.com`')).toBe(false);
    expect(isValidNpmPackage('')).toBe(false);
    expect(isValidNpmPackage('A'.repeat(215))).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isValidNpmPackage(null)).toBe(false);
    expect(isValidNpmPackage(undefined)).toBe(false);
    expect(isValidNpmPackage(123)).toBe(false);
  });
});

describe('isPathInsideDir', () => {
  const base = '/home/user/workspace';

  it('allows paths inside the directory', () => {
    expect(isPathInsideDir('file.txt', base)).toBe(true);
    expect(isPathInsideDir('sub/file.txt', base)).toBe(true);
    expect(isPathInsideDir('./file.txt', base)).toBe(true);
  });

  it('blocks path traversal', () => {
    expect(isPathInsideDir('../etc/passwd', base)).toBe(false);
    expect(isPathInsideDir('../../root/.ssh/id_rsa', base)).toBe(false);
    expect(isPathInsideDir('sub/../../outside', base)).toBe(false);
  });

  it('blocks absolute paths outside dir', () => {
    expect(isPathInsideDir('/etc/passwd', base)).toBe(false);
    expect(isPathInsideDir('/tmp/evil', base)).toBe(false);
  });

  it('allows the base dir itself', () => {
    expect(isPathInsideDir('.', base)).toBe(true);
  });
});

describe('isAllowedUrl', () => {
  it('allows public URLs', () => {
    expect(isAllowedUrl('https://example.com')).toBe(true);
    expect(isAllowedUrl('https://api.github.com/repos')).toBe(true);
    expect(isAllowedUrl('http://example.org')).toBe(true);
  });

  it('blocks localhost', () => {
    expect(isAllowedUrl('http://localhost')).toBe(false);
    expect(isAllowedUrl('http://127.0.0.1')).toBe(false);
    expect(isAllowedUrl('http://0.0.0.0')).toBe(false);
    expect(isAllowedUrl('http://[::1]')).toBe(false);
  });

  it('blocks private IPs', () => {
    expect(isAllowedUrl('http://10.0.0.1')).toBe(false);
    expect(isAllowedUrl('http://172.16.0.1')).toBe(false);
    expect(isAllowedUrl('http://192.168.1.1')).toBe(false);
  });

  it('blocks AWS metadata endpoint', () => {
    expect(isAllowedUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('blocks internal hostnames', () => {
    expect(isAllowedUrl('http://service.local')).toBe(false);
    expect(isAllowedUrl('http://api.internal')).toBe(false);
  });

  it('blocks non-http protocols', () => {
    expect(isAllowedUrl('ftp://example.com')).toBe(false);
    expect(isAllowedUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isAllowedUrl('not-a-url')).toBe(false);
    expect(isAllowedUrl('')).toBe(false);
  });
});

describe('execAsync', () => {
  it('executes simple commands', async () => {
    const result = await execAsync('echo hello');
    expect(result.trim()).toBe('hello');
  });

  it('rejects on failure', async () => {
    await expect(execAsync('false')).rejects.toThrow();
  });

  it('respects timeout', async () => {
    await expect(execAsync('sleep 10', { timeout: 100 })).rejects.toThrow();
  });
});
