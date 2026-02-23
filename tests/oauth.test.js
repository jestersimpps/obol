import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const {
  generatePKCE,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshTokens,
  isExpired,
  isOAuthToken,
} = await import('../src/oauth.js');

describe('oauth', () => {
  describe('generatePKCE', () => {
    it('returns verifier and challenge as strings', async () => {
      const { verifier, challenge } = await generatePKCE();
      expect(typeof verifier).toBe('string');
      expect(typeof challenge).toBe('string');
    });

    it('verifier is base64url encoded (no +, /, =)', async () => {
      const { verifier } = await generatePKCE();
      expect(verifier).not.toMatch(/[+/=]/);
    });

    it('challenge is base64url encoded (no +, /, =)', async () => {
      const { challenge } = await generatePKCE();
      expect(challenge).not.toMatch(/[+/=]/);
    });

    it('challenge is sha256 of verifier in base64url', async () => {
      const { verifier, challenge } = await generatePKCE();
      const hash = crypto.createHash('sha256').update(verifier).digest();
      const expected = Buffer.from(hash)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(challenge).toBe(expected);
    });

    it('generates unique values each call', async () => {
      const a = await generatePKCE();
      const b = await generatePKCE();
      expect(a.verifier).not.toBe(b.verifier);
      expect(a.challenge).not.toBe(b.challenge);
    });
  });

  describe('buildAuthorizationUrl', () => {
    it('returns a URL starting with the authorize endpoint', () => {
      const url = buildAuthorizationUrl('test-challenge', 'test-verifier');
      expect(url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
    });

    it('includes all required parameters', () => {
      const url = buildAuthorizationUrl('my-challenge', 'my-verifier');
      const parsed = new URL(url);
      expect(parsed.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://console.anthropic.com/oauth/code/callback');
      expect(parsed.searchParams.get('scope')).toBe('org:create_api_key user:profile user:inference');
      expect(parsed.searchParams.get('code_challenge')).toBe('my-challenge');
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsed.searchParams.get('state')).toBe('my-verifier');
      expect(parsed.searchParams.get('code')).toBe('true');
    });
  });

  describe('isExpired', () => {
    it('returns true when expires is in the past', () => {
      expect(isExpired({ expires: Date.now() - 1000 })).toBe(true);
    });

    it('returns true when expires equals now', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      expect(isExpired({ expires: now })).toBe(true);
      vi.restoreAllMocks();
    });

    it('returns false when expires is in the future', () => {
      expect(isExpired({ expires: Date.now() + 60000 })).toBe(false);
    });
  });

  describe('isOAuthToken', () => {
    it('returns true for tokens containing sk-ant-oat', () => {
      expect(isOAuthToken('sk-ant-oat-abc123')).toBe(true);
    });

    it('returns true when sk-ant-oat appears anywhere in the string', () => {
      expect(isOAuthToken('prefix-sk-ant-oat-suffix')).toBe(true);
    });

    it('returns false for API key tokens', () => {
      expect(isOAuthToken('sk-ant-api01-xxxxx')).toBe(false);
    });

    it('returns falsy for null', () => {
      expect(isOAuthToken(null)).toBeFalsy();
    });

    it('returns falsy for undefined', () => {
      expect(isOAuthToken(undefined)).toBeFalsy();
    });

    it('returns falsy for empty string', () => {
      expect(isOAuthToken('')).toBeFalsy();
    });
  });

  describe('exchangeCodeForTokens', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('calls TOKEN_URL with correct body and returns parsed tokens', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'sk-ant-oat-access',
          refresh_token: 'sk-ant-oat-refresh',
          expires_in: 3600,
        }),
      };
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const result = await exchangeCodeForTokens('auth-code', 'state-val', 'verifier-val');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://console.anthropic.com/v1/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
            code: 'auth-code',
            state: 'state-val',
            redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
            code_verifier: 'verifier-val',
          }),
        },
      );

      expect(result.accessToken).toBe('sk-ant-oat-access');
      expect(result.refreshToken).toBe('sk-ant-oat-refresh');
      expect(result.expires).toBe(now + 3600 * 1000 - 5 * 60 * 1000);

      vi.restoreAllMocks();
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'bad request',
      });

      await expect(exchangeCodeForTokens('bad', 's', 'v')).rejects.toThrow('Token exchange failed (400): bad request');
    });
  });

  describe('refreshTokens', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('calls TOKEN_URL with refresh_token grant and returns parsed tokens', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          access_token: 'sk-ant-oat-new-access',
          refresh_token: 'sk-ant-oat-new-refresh',
          expires_in: 7200,
        }),
      };
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const result = await refreshTokens('sk-ant-oat-old-refresh');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://console.anthropic.com/v1/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
            refresh_token: 'sk-ant-oat-old-refresh',
          }),
        },
      );

      expect(result.accessToken).toBe('sk-ant-oat-new-access');
      expect(result.refreshToken).toBe('sk-ant-oat-new-refresh');
      expect(result.expires).toBe(now + 7200 * 1000 - 5 * 60 * 1000);

      vi.restoreAllMocks();
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      });

      await expect(refreshTokens('bad-token')).rejects.toThrow('Token refresh failed (401): unauthorized');
    });
  });
});
