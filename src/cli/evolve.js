const { loadConfig, ensureUserDir } = require('../config');
const { createMemory } = require('../memory');
const { createSelfMemory } = require('../memory/self');
const { createMessageLog } = require('../messages');
const { createAnthropicClient } = require('../claude/client');

async function runEvolve({ userId: userIdArg } = {}) {
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

  console.log(`Starting evolution for user ${userId}...`);

  const client = createAnthropicClient(config.anthropic);
  const memory = await createMemory(config.supabase, userId);
  const selfMemory = await createSelfMemory(config.supabase, 0).catch(() => null);
  const messageLog = createMessageLog(config.supabase, memory, config.anthropic, userId, userDir);

  try {
    const { evolve } = require('../evolve');
    const result = await evolve(client, messageLog, memory, userDir, config.supabase, selfMemory);

    console.log(`\nEvolution #${result.evolutionNumber} complete`);
    console.log(`  Soul: ${result.previousLength} → ${result.newLength} chars`);

    if (result.scriptsFixed) console.log('  Scripts: fixed after test regression');
    else if (result.scriptsRolledBack) console.log('  Scripts: rolled back (tests failed)');

    if (result.upgrades?.length > 0) {
      console.log('  New capabilities:');
      for (const u of result.upgrades) {
        console.log(`    - ${u.name}: ${u.description}`);
      }
    }

    if (result.deployedApps?.length > 0) {
      console.log('  Deployed:');
      for (const app of result.deployedApps) {
        console.log(`    - ${app.name}${app.url ? ` → ${app.url}` : ` (failed: ${app.error})`}`);
      }
    }

    if (result.changelog) console.log(`\n  ${result.changelog}`);
  } catch (e) {
    console.error(`Evolution failed: ${e.message}`);
    process.exit(1);
  } finally {
    delete process.env.OBOL_VERBOSE;
  }
}

module.exports = { evolve: runEvolve };
