const { RATE_LIMIT_MS, SPAM_THRESHOLD, SPAM_COOLDOWN_MS } = require('./constants');

const API_KEY_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /ghp_[a-zA-Z0-9]{36,}/,
  /gho_[a-zA-Z0-9]{36,}/,
  /ghu_[a-zA-Z0-9]{36,}/,
  /ghs_[a-zA-Z0-9]{36,}/,
  /github_pat_[a-zA-Z0-9_]{20,}/,
  /xoxb-[a-zA-Z0-9\-]{20,}/,
  /xoxp-[a-zA-Z0-9\-]{20,}/,
  /xoxs-[a-zA-Z0-9\-]{20,}/,
  /AKIA[A-Z0-9]{16}/,
  /eyJ[a-zA-Z0-9_-]{50,}/,
];

function containsApiKey(text) {
  return API_KEY_PATTERNS.some(pattern => pattern.test(text));
}

function createRateLimiter() {
  const rateLimits = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, val] of rateLimits) {
      if (now - val.lastMessage > 300000) rateLimits.delete(key);
    }
  }, 600000);
  cleanup.unref();

  function check(userId) {
    const now = Date.now();
    const userLimit = rateLimits.get(userId) || { lastMessage: 0, spamCount: 0, cooldownUntil: 0 };
    if (now < userLimit.cooldownUntil) return 'cooldown';
    if (now - userLimit.lastMessage < RATE_LIMIT_MS) {
      userLimit.spamCount++;
      userLimit.lastMessage = now;
      rateLimits.set(userId, userLimit);
      if (userLimit.spamCount >= SPAM_THRESHOLD) {
        userLimit.cooldownUntil = now + SPAM_COOLDOWN_MS;
        rateLimits.set(userId, userLimit);
        return 'spam';
      }
      return userLimit.spamCount === 1 ? 'slow' : 'skip';
    }
    userLimit.lastMessage = now;
    userLimit.spamCount = 0;
    rateLimits.set(userId, userLimit);
    return null;
  }

  return { check, cleanup };
}

module.exports = { containsApiKey, createRateLimiter };
