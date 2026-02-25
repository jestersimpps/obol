const { loadEvolutionState } = require('./state');

const MIN_EXCHANGES_FOR_EVOLUTION = 10;

async function checkEvolution(userDir, messageLog) {
  const state = loadEvolutionState(userDir);
  const { loadConfig } = require('../config');
  const config = loadConfig();

  const intervalMs = (config?.evolution?.intervalHours ?? 24) * 60 * 60 * 1000;
  const minExchanges = config?.evolution?.minExchanges ?? MIN_EXCHANGES_FOR_EVOLUTION;
  const elapsed = state.lastEvolution ? Date.now() - new Date(state.lastEvolution).getTime() : Infinity;

  if (elapsed < intervalMs) return { ready: false };
  if (!messageLog?.url) return { ready: false };

  const sinceFilter = state.lastEvolution ? `&created_at=gt.${state.lastEvolution}` : '';
  const userFilter = messageLog.userId ? `&user_id=eq.${messageLog.userId}` : '';
  const res = await fetch(
    `${messageLog.url}/rest/v1/obol_messages?select=id&role=eq.assistant&limit=${minExchanges}${sinceFilter}${userFilter}`,
    { headers: messageLog.headers }
  );
  const rows = await res.json();

  return { ready: Array.isArray(rows) && rows.length >= minExchanges };
}

module.exports = { checkEvolution };
