const crypto = require('crypto');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function base64urlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generatePKCE() {
  const verifierBytes = crypto.randomBytes(32);
  const verifier = base64urlEncode(verifierBytes);
  const hash = crypto.createHash('sha256').update(verifier).digest();
  const challenge = base64urlEncode(hash);
  return { verifier, challenge };
}

function buildAuthorizationUrl(challenge, verifier) {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, state, verifier) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - REFRESH_BUFFER_MS,
  };
}

async function refreshTokens(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - REFRESH_BUFFER_MS,
  };
}

function isExpired(oauthCreds) {
  return Date.now() >= oauthCreds.expires;
}

function isOAuthToken(token) {
  return token && token.includes('sk-ant-oat');
}

module.exports = {
  generatePKCE,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshTokens,
  isExpired,
  isOAuthToken,
};
