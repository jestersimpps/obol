/** @typedef {{ login: string, scopes: string }} GitHubUser */
/** @typedef {{ token: string, username: string, repo: string }} GitHubConfig */

/**
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function validateAnthropic(apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  if (res.status === 200) return 'Key valid';
  if (res.status === 401) throw new Error('Invalid API key');
  if (res.status === 403) throw new Error('Key lacks permissions');
  if (res.status === 400) {
    const body = await res.json();
    if (body.error?.message?.includes('billing')) throw new Error('No credits — add funds at console.anthropic.com');
    throw new Error(`Bad request: ${body.error?.message || 'unknown'}`);
  }
  if (res.status === 429) throw new Error('Rate limited — key is valid but try again later');
  if (res.status >= 500) throw new Error(`Anthropic server error (${res.status}) — try again later`);
  throw new Error(`Unexpected response (${res.status}) — check your key`);
}

/**
 * @param {string} token
 * @returns {Promise<string>}
 */
async function validateTelegram(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = await res.json();
  if (!data.ok) throw new Error('Invalid bot token');
  return `Bot: @${data.result.username}`;
}

/**
 * @param {string} url
 * @param {string} serviceKey
 * @returns {Promise<string>}
 */
async function validateSupabase(url, serviceKey) {
  const res = await fetch(`${url}/rest/v1/`, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    },
  });
  if (res.status === 401 || res.status === 403) throw new Error('Invalid service key');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return 'Connected';
}

/**
 * @param {string} token
 * @returns {Promise<string>}
 */
async function validateVercel(token) {
  const res = await fetch('https://api.vercel.com/v9/projects', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) throw new Error('Invalid token');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return 'Token valid';
}

/**
 * @param {string} token
 * @returns {Promise<GitHubUser>}
 */
async function validateGitHub(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: { 'Authorization': `token ${token}` },
  });
  const user = await res.json();
  if (!user.login) throw new Error('Invalid token');
  const scopes = res.headers.get('x-oauth-scopes') || '';
  return { login: user.login, scopes };
}

/**
 * @param {string} token
 * @param {string} username
 * @returns {Promise<GitHubConfig>}
 */
async function createGitHubRepo(token, username) {
  const repoName = 'obol-brain';
  const res = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: repoName,
      private: true,
      description: 'OBOL brain backup',
      auto_init: true,
    }),
  });

  if (res.status === 422) {
    return { token, username, repo: repoName };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { token, username, repo: repoName };
}

module.exports = {
  validateAnthropic,
  validateTelegram,
  validateSupabase,
  validateVercel,
  validateGitHub,
  createGitHubRepo,
};
