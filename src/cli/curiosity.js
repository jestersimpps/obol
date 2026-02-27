const { loadConfig, ensureUserDir } = require('../config');
const { createMemory } = require('../memory');
const { createSelfMemory } = require('../memory/self');
const { createPatterns } = require('../soul/patterns');
const { createAnthropicClient } = require('../claude/client');
const { runCuriosity } = require('../curiosity');

async function runCuriosityCli({ userId: userIdArg } = {}) {
  process.env.OBOL_VERBOSE = '1';

  const config = loadConfig({ resolve: false });

  if (!config?.anthropic) {
    console.error('Anthropic not configured. Run: obol init');
    process.exit(1);
  }

  if (!config?.supabase) {
    console.error('Supabase not configured. Run: obol init');
    process.exit(1);
  }

  const allowedUsers = config.telegram?.allowedUsers || [];
  const userId = userIdArg || allowedUsers[0];

  if (!userId) {
    console.error('No user ID found. Pass <userId> or configure telegram.allowedUsers');
    process.exit(1);
  }

  const userDir = ensureUserDir(userId);

  console.log(`Starting curiosity cycle for user ${userId}...`);

  const client = createAnthropicClient(config.anthropic);
  const selfMemory = await createSelfMemory(config.supabase, 0);
  const memory = await createMemory(config.supabase, userId).catch(() => null);
  const patterns = await createPatterns(config.supabase, userId).catch(() => null);

  const parts = [];
  if (memory) {
    const recent = await memory.recent({ limit: 3 }).catch(() => []);
    if (recent.length) parts.push(recent.map(m => `- ${m.content}`).join('\n'));
  }
  if (patterns) {
    const fmt = await patterns.format().catch(() => null);
    if (fmt) parts.push(fmt);
  }
  const peopleContext = parts.join('\n\n') || undefined;

  try {
    const result = await runCuriosity(client, selfMemory, userId, { memory, patterns, peopleContext, userDir });
    console.log(`\nCuriosity cycle complete — stored ${result.count} things`);
  } catch (e) {
    console.error(`Curiosity cycle failed: ${e.message}`);
    process.exit(1);
  } finally {
    delete process.env.OBOL_VERBOSE;
  }
}

module.exports = { curiosity: runCuriosityCli };
