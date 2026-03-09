const Anthropic = require('@anthropic-ai/sdk');
const { refreshTokens, isExpired } = require('../auth/oauth');
const { saveConfig, loadConfig } = require('../config');

function createAnthropicClient(anthropicConfig, { useOAuth = true } = {}) {
  if (useOAuth && anthropicConfig.oauth?.accessToken) {
    return new Anthropic({
      apiKey: null,
      authToken: anthropicConfig.oauth.accessToken,
      maxRetries: 5,
      defaultHeaders: {
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,output-128k-2025-02-19',
      },
    });
  }
  if (anthropicConfig.apiKey) {
    return new Anthropic({
      apiKey: anthropicConfig.apiKey,
      maxRetries: 5,
      defaultHeaders: {
        'anthropic-beta': 'output-128k-2025-02-19',
      },
    });
  }
  throw new Error('No Anthropic credentials configured. Run: obol config');
}

let _refreshPromise = null;

async function ensureFreshToken(anthropicConfig) {
  if (!anthropicConfig.oauth?.accessToken) return;
  if (!isExpired(anthropicConfig.oauth)) return;
  if (!anthropicConfig.oauth.refreshToken) {
    if (anthropicConfig.apiKey) {
      anthropicConfig._oauthFailed = true;
      return;
    }
    const err = new Error('OAuth token expired and no refresh token available. Re-authenticate with: obol config → Anthropic → OAuth');
    err.isOAuthExpiry = true;
    throw err;
  }

  if (_refreshPromise) {
    try {
      await _refreshPromise;
    } catch {}
    if (!isExpired(anthropicConfig.oauth)) return;
    if (anthropicConfig._oauthFailed) return;
  }

  _refreshPromise = (async () => {
    try {
      const tokens = await refreshTokens(anthropicConfig.oauth.refreshToken);
      console.log('[oauth] Refresh succeeded, new refresh token:', !!tokens.refreshToken);
      anthropicConfig.oauth.accessToken = tokens.accessToken;
      if (tokens.refreshToken) anthropicConfig.oauth.refreshToken = tokens.refreshToken;
      anthropicConfig.oauth.expires = tokens.expires;
      delete anthropicConfig._oauthFailed;

      const config = loadConfig({ resolve: false });
      if (config) {
        config.anthropic.oauth = anthropicConfig.oauth;
        saveConfig(config);
      }
    } catch (e) {
      console.warn('[oauth] Refresh failed, checking disk for updated tokens:', e.message);
      const diskConfig = loadConfig({ resolve: false });
      if (diskConfig?.anthropic?.oauth?.accessToken &&
          diskConfig.anthropic.oauth.accessToken !== anthropicConfig.oauth.accessToken &&
          !isExpired(diskConfig.anthropic.oauth)) {
        anthropicConfig.oauth.accessToken = diskConfig.anthropic.oauth.accessToken;
        anthropicConfig.oauth.refreshToken = diskConfig.anthropic.oauth.refreshToken;
        anthropicConfig.oauth.expires = diskConfig.anthropic.oauth.expires;
        delete anthropicConfig._oauthFailed;
        return;
      }

      if (anthropicConfig.apiKey) {
        console.warn('[oauth] Token refresh failed, falling back to API key:', e.message);
        anthropicConfig._oauthFailed = true;
      } else {
        const err = new Error(`OAuth token expired and refresh failed: ${e.message}`);
        err.isOAuthExpiry = true;
        throw err;
      }
    }
  })();

  try {
    await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}

module.exports = { createAnthropicClient, ensureFreshToken };
