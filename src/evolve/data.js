const CATEGORY_LABELS = {
  person: 'People', decision: 'Decisions', preference: 'Preferences',
  lesson: 'Lessons', project: 'Projects', fact: 'Facts',
  event: 'Events', pattern: 'Patterns', context: 'Context',
};

const SELF_CATEGORY_LABELS = {
  research: 'Research', interest: 'Interests', self: 'Self-reflection', pattern: 'Patterns',
};

/**
 * @param {Array} memories
 * @param {object} categoryLabels
 * @returns {string}
 */
function formatMemoryGroups(memories, categoryLabels, { includeDate = false, includeSource = false } = {}) {
  const groups = {};
  for (const m of memories) {
    const group = categoryLabels[m.category] || 'Other';
    if (!groups[group]) groups[group] = [];
    let entry = m.content;
    if (includeDate && m.created_at) {
      const date = new Date(m.created_at).toISOString().slice(0, 10);
      const sourceTag = includeSource && m.source ? ` [${m.source}]` : '';
      entry = `${m.content} _(${date}${sourceTag})_`;
    }
    groups[group].push(entry);
  }
  return Object.entries(groups)
    .map(([group, items]) => `### ${group}\n${items.map(i => `- ${i}`).join('\n')}`)
    .join('\n\n');
}

/**
 * @param {object|null} messageLog
 * @param {object} state
 * @returns {Promise<Array>}
 */
async function fetchRecentMessages(messageLog, state) {
  if (!messageLog) return [];
  try {
    const userFilter = messageLog.userId ? `&user_id=eq.${messageLog.userId}` : '';
    const sinceFilter = state.lastEvolution ? `&created_at=gt.${state.lastEvolution}` : '';
    const res = await fetch(
      `${messageLog.url}/rest/v1/obol_messages?order=created_at.asc&limit=500&select=role,content,created_at${userFilter}${sinceFilter}`,
      { headers: messageLog.headers }
    );
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[evolve] Failed to fetch recent messages:', e.message);
    return [];
  }
}

/**
 * @param {object|null} memory
 * @param {object|null} messageLog
 * @param {object} state
 * @returns {Promise<{ coreMemories: Array, recentMemories: Array }>}
 */
async function fetchMemories(memory, messageLog, state) {
  if (!memory) return { coreMemories: [], recentMemories: [] };

  const headers = messageLog?.headers || {};
  const url = messageLog?.url;
  if (!url) return { coreMemories: [], recentMemories: [] };

  const memUserFilter = messageLog?.userId ? `&user_id=eq.${messageLog.userId}` : '';

  let coreMemories = [];
  try {
    const res = await fetch(
      `${url}/rest/v1/obol_memory?select=content,category,importance&order=importance.desc,accessed_at.desc&limit=20${memUserFilter}`,
      { headers }
    );
    const coreData = await res.json();
    coreMemories = Array.isArray(coreData) ? coreData : [];
  } catch (e) {
    console.error('[evolve] Failed to fetch core memories:', e.message);
  }

  let recentMemories = [];
  try {
    const sinceFilter = state.lastEvolution ? `&created_at=gt.${state.lastEvolution}` : '';
    const res = await fetch(
      `${url}/rest/v1/obol_memory?select=content,category,importance,tags,created_at,source&order=created_at.asc&limit=100${memUserFilter}${sinceFilter}`,
      { headers }
    );
    const recentData = await res.json();
    recentMemories = Array.isArray(recentData) ? recentData : [];
  } catch (e) {
    console.error('[evolve] Failed to fetch recent memories:', e.message);
  }

  return { coreMemories, recentMemories };
}

/**
 * @param {object|null} selfMemory
 * @returns {Promise<Array>}
 */
async function fetchSelfMemories(selfMemory) {
  if (!selfMemory) return [];
  try {
    return await selfMemory.query({ minImportance: 0.5, limit: 30 });
  } catch (e) {
    console.error('[evolve] Failed to fetch self memories:', e.message);
    return [];
  }
}

/**
 * @param {Array} coreMemories
 * @returns {string}
 */
function formatCoreMemories(coreMemories) {
  return formatMemoryGroups(coreMemories, CATEGORY_LABELS);
}

/**
 * @param {Array} recentMemories
 * @returns {string}
 */
function formatRecentMemories(recentMemories) {
  return formatMemoryGroups(recentMemories, CATEGORY_LABELS, { includeDate: true, includeSource: true });
}

/**
 * @param {Array} selfMemories
 * @returns {string}
 */
function formatSelfMemories(selfMemories) {
  return formatMemoryGroups(selfMemories, SELF_CATEGORY_LABELS);
}

module.exports = {
  fetchRecentMessages,
  fetchMemories,
  fetchSelfMemories,
  formatCoreMemories,
  formatRecentMemories,
  formatSelfMemories,
};
