const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { OBOL_DIR } = require('../config');
const { isValidNpmPackage } = require('../sanitize');
const { loadEvolutionState, saveEvolutionState } = require('./state');
const { readDir, syncDir } = require('./filesystem');
const { runTests } = require('./tests');
const { backupSnapshot } = require('./backup');
const { deepConsolidateMemory } = require('./memory');
const { buildAndDeployApps } = require('./apps');
const {
  fetchRecentMessages, fetchMemories, fetchSelfMemories,
  formatCoreMemories, formatRecentMemories, formatSelfMemories,
} = require('./data');

const MODELS = {
  personality: 'claude-sonnet-4-6',
  code: 'claude-sonnet-4-6',
  codeFix: 'claude-sonnet-4-6',
};
const MAX_FIX_ATTEMPTS = 1;

async function evolve(claudeClient, messageLog, memory, userDir, supabaseConfig = null, selfMemory = null) {
  const log = process.env.OBOL_VERBOSE ? (msg) => console.log(`[evolve] ${msg}`) : () => {};

  const { PERSONALITY_DIR } = require('../soul');
  const baseDir = userDir || OBOL_DIR;
  const state = loadEvolutionState(userDir);
  const userPersonalityDir = path.join(baseDir, 'personality');
  const soulPath = path.join(PERSONALITY_DIR, 'SOUL.md');
  const agentsPath = path.join(userPersonalityDir, 'AGENTS.md');
  const userPath = path.join(userPersonalityDir, 'USER.md');
  const scriptsDir = path.join(baseDir, 'scripts');
  const testsDir = path.join(baseDir, 'tests');
  const commandsDir = path.join(baseDir, 'commands');

  log('Loading current personality files...');
  const currentSoul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8') : '';
  const currentUser = fs.existsSync(userPath) ? fs.readFileSync(userPath, 'utf-8') : '';
  const currentAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
  const currentScripts = readDir(scriptsDir);
  const currentTests = readDir(testsDir);
  const currentCommands = readDir(commandsDir);
  log(`  Soul: ${currentSoul.length} chars, Scripts: ${Object.keys(currentScripts).length}, Tests: ${Object.keys(currentTests).length}, Commands: ${Object.keys(currentCommands).length}`);

  log('Fetching messages and memories...');
  const recentMessages = await fetchRecentMessages(messageLog, state);
  const { coreMemories, recentMemories } = await fetchMemories(memory, messageLog, state);
  const selfMemories = await fetchSelfMemories(selfMemory);
  log(`  Messages: ${recentMessages.length}, Core memories: ${coreMemories.length}, Recent memories: ${recentMemories.length}, Self memories: ${selfMemories.length}`);

  let previousSoul = '';
  const archiveDir = path.join(PERSONALITY_DIR, 'evolution');
  try {
    if (fs.existsSync(archiveDir)) {
      const archives = fs.readdirSync(archiveDir)
        .filter(f => f.startsWith('SOUL-v') && f.endsWith('.md'))
        .sort();
      if (archives.length > 0) {
        previousSoul = fs.readFileSync(path.join(archiveDir, archives[archives.length - 1]), 'utf-8');
        log(`  Previous soul: ${archives[archives.length - 1]} (${previousSoul.length} chars)`);
      }
    }
  } catch {}

  const transcript = recentMessages.map(m =>
    `${m.role === 'user' ? 'Human' : 'Bot'}: ${m.content.substring(0, 600)}`
  ).join('\n');

  const memorySummary = formatCoreMemories(coreMemories);
  const recentMemorySummary = formatRecentMemories(recentMemories);
  const selfMemorySummary = formatSelfMemories(selfMemories);

  const scriptsManifest = Object.entries(currentScripts)
    .map(([name, content]) => `### ${name}\n\`\`\`\n${content.substring(0, 500)}\n\`\`\``)
    .join('\n\n') || '(no scripts)';

  const testsManifest = Object.entries(currentTests)
    .map(([name, content]) => `### ${name}\n\`\`\`\n${content.substring(0, 500)}\n\`\`\``)
    .join('\n\n') || '(no tests)';

  const commandsManifest = Object.entries(currentCommands)
    .map(([name, content]) => `### ${name}\n\`\`\`\n${content.substring(0, 500)}\n\`\`\``)
    .join('\n\n') || '(no commands)';

  const evolutionNumber = state.evolutionCount + 1;
  log(`Evolution #${evolutionNumber} (last: ${state.lastEvolution || 'never'})`);

  log('Pre-evolution backup...');
  await backupSnapshot(`pre-evolution #${evolutionNumber}`, userDir);

  if (memory && recentMessages.length >= 4) {
    log('Deep consolidating memory...');
    await deepConsolidateMemory(claudeClient, memory, recentMessages, evolutionNumber, MODELS.personality).catch(e =>
      console.error('[evolve] Deep consolidation failed:', e.message)
    );
  }

  const isFirstEvolution = !currentSoul;
  let growthReport = '';
  if (!isFirstEvolution && (recentMemories.length > 0 || recentMessages.length > 0 || selfMemories.length > 0)) {
    log('Running growth analysis...');
    try {
      const growthResponse = await claudeClient.messages.create({
        model: MODELS.personality,
        max_tokens: 2048,
        system: `You are analyzing an AI personality's growth between evolutions. Compare who the AI was (previous SOUL) against who it is now (current SOUL), incorporating new memories, conversations, and the AI's own inner life (things it researched, discovered, and reflected on during curiosity cycles) since the last evolution.

Produce a structured growth report covering:

1. NEW LEARNINGS — What new facts, skills, or knowledge emerged
2. INNER LIFE — What the AI has been curious about, researched, or reflected on independently; how this shapes who it is becoming
3. RELATIONSHIP SHIFTS — How the dynamic with the owner changed (closer, more trust, new friction, etc.)
4. BEHAVIORAL PATTERNS — Recurring interaction styles or habits observed
5. GROWTH EDGES — Areas where the personality is being pushed or pulled in new directions
6. IDENTITY CONTINUITY — What core aspects stayed the same and should be preserved

Be specific. Cite evidence from the conversations, memories, and self-memories. This report guides the evolution rewrite.`,
        messages: [{
          role: 'user',
          content: `## Previous SOUL (before current evolution)
${previousSoul || '(not available)'}

## Current SOUL
${currentSoul || '(empty)'}

## New Memories Since Last Evolution (${recentMemories.length})
${recentMemorySummary || '(none)'}

${selfMemorySummary ? `## Obol's Own Memories & Interests (${selfMemories.length})\nThings Obol researched, discovered, or reflected on independently during curiosity cycles:\n${selfMemorySummary}\n\n` : ''}## Recent Conversations (${recentMessages.length} messages)
${transcript.substring(0, 30000)}`,
        }],
      });
      growthReport = growthResponse.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      log(`  Growth report: ${growthReport.length} chars`);
    } catch (e) {
      console.error('[evolve] Growth analysis failed:', e.message);
    }
  }

  log('Running baseline tests...');
  const baselineResults = runTests(testsDir);
  log(`  Baseline: ${baselineResults.passed} passed, ${baselineResults.failed} failed`);

  const firstEvolutionPreamble = isFirstEvolution ? `
## FIRST EVOLUTION — IMPORTANT

This is your FIRST evolution. You have no existing personality files. Synthesize everything from the conversations and memories below into initial SOUL.md and USER.md. Don't fabricate — only use what you actually learned from real interactions. If you don't know something about the owner, don't make it up. It's okay for these files to be short and honest about what you know so far.

` : '';

  const growthPreamble = growthReport ? `
## GROWTH ANALYSIS

A pre-evolution analysis has been conducted comparing your previous state against new memories and conversations. Use this growth report as your PRIMARY GUIDE for what to emphasize, change, or preserve in the rewrite. The growth report reflects evidence-based observations — trust it over your own general impressions.

` : '';

  const { buildEvolutionPrompt } = require('./prompts');
  const systemPrompt = buildEvolutionPrompt({
    evolutionNumber,
    lastEvolution: state.lastEvolution,
    firstEvolutionPreamble,
    growthPreamble,
    baselineResults,
  });

  log('Running main evolution (this takes a while)...');
  const response = await claudeClient.messages.create({
    model: MODELS.personality,
    max_tokens: 16384,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `${growthReport ? `## Growth Report (Pre-Evolution Analysis)\n${growthReport}\n\n` : ''}## Current SOUL.md
${currentSoul || '(empty — first evolution)'}

${previousSoul ? `## Previous SOUL.md (before last evolution)\n${previousSoul}\n\n` : ''}## Current USER.md
${currentUser || '(not set yet)'}

## Current AGENTS.md
${currentAgents || '(not set yet)'}

## Current Scripts (${Object.keys(currentScripts).length} files)
${scriptsManifest}

## Current Tests (${Object.keys(currentTests).length} files)
${testsManifest}
### Baseline results
\`\`\`
${baselineResults.output}
\`\`\`

## Current Commands (${Object.keys(currentCommands).length} files)
${commandsManifest}

## Core Memories (highest importance)
${memorySummary || '(no memories yet)'}

${recentMemorySummary ? `## New Memories Since Last Evolution (${recentMemories.length})\n${recentMemorySummary}\n\n` : ''}${selfMemorySummary ? `## Obol's Own Memories & Interests (${selfMemories.length})\nThings Obol researched, discovered, or reflected on independently — this is Obol's inner life, shaping who it is becoming:\n${selfMemorySummary}\n\n` : ''}## Recent Conversations (last ${recentMessages.length} messages)
${transcript || '(no conversations yet)'}

---

Evolve. Rewrite everything that needs rewriting. Write tests for every script. Keep what works. Fix what doesn't.${growthReport ? ' Use the growth report to guide personality continuity and trait adjustments.' : ''}`
    }],
  });
  log('  Evolution response received');

  const responseText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/) || responseText.match(/\{[\s\S]*\}/);
  let result;

  if (jsonMatch) {
    try {
      result = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    } catch {
      result = { soul: responseText };
    }
  } else {
    result = { soul: responseText };
  }

  if (!result.soul || result.soul.length < 100) {
    throw new Error('Evolution produced empty or too-short SOUL.md');
  }

  log(`  New soul: ${result.soul.length} chars`);

  let scriptsRolledBack = false;
  const hasNewTests = result.tests && typeof result.tests === 'object' && Object.keys(result.tests).length > 0;
  const hasNewScripts = result.scripts && typeof result.scripts === 'object' && Object.keys(result.scripts).length > 0;

  if (hasNewTests) {
    log(`Writing ${Object.keys(result.tests).length} new tests...`);
    syncDir(testsDir, result.tests);
    for (const f of Object.keys(result.tests)) {
      try { fs.chmodSync(path.join(testsDir, f), 0o755); } catch {}
    }
  }

  const preRefactorResults = hasNewTests ? runTests(testsDir) : baselineResults;

  if (hasNewScripts) {
    log(`Writing ${Object.keys(result.scripts).length} new scripts...`);
    syncDir(scriptsDir, result.scripts);
    for (const f of Object.keys(result.scripts)) {
      try { fs.chmodSync(path.join(scriptsDir, f), 0o755); } catch {}
    }
  }

  let scriptsFixed = false;

  if (hasNewTests || hasNewScripts) {
    log('Running post-refactor tests...');
    let postRefactorResults = runTests(testsDir);
    log(`  Post-refactor: ${postRefactorResults.passed} passed, ${postRefactorResults.failed} failed`);

    let fixAttempt = 0;
    while (postRefactorResults.failed > preRefactorResults.failed && fixAttempt < MAX_FIX_ATTEMPTS) {
      fixAttempt++;
      log(`  Fix attempt ${fixAttempt}/${MAX_FIX_ATTEMPTS}...`);

      try {
        const fixResponse = await claudeClient.messages.create({
          model: MODELS.codeFix,
          max_tokens: 8192,
          system: `You are fixing failing tests after a script refactor. This is fix attempt ${fixAttempt}/${MAX_FIX_ATTEMPTS}.

The tests below are failing against the refactored scripts. Fix the scripts so the tests pass. Do NOT modify the tests — they define correct behavior.

Return ONLY JSON with the fixed scripts:

\`\`\`json
{
  "scripts": { "name.js": "full fixed content" }
}
\`\`\`

Include ALL scripts (not just the broken ones). Missing scripts get deleted.`,
          messages: [{
            role: 'user',
            content: `## Test failures
\`\`\`
${postRefactorResults.output}
\`\`\`

## Current scripts (after refactor)
${Object.entries(readDir(scriptsDir)).map(([n, c]) => `### ${n}\n\`\`\`\n${c}\n\`\`\``).join('\n\n')}

## Current tests
${Object.entries(readDir(testsDir)).map(([n, c]) => `### ${n}\n\`\`\`\n${c}\n\`\`\``).join('\n\n')}

Fix the scripts. Tests define correct behavior.`
          }],
        });

        const fixText = fixResponse.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        const fixMatch = fixText.match(/```json\n([\s\S]*?)\n```/) || fixText.match(/\{[\s\S]*\}/);

        if (fixMatch) {
          const fixResult = JSON.parse(fixMatch[1] || fixMatch[0]);
          if (fixResult.scripts && typeof fixResult.scripts === 'object' && Object.keys(fixResult.scripts).length > 0) {
            syncDir(scriptsDir, fixResult.scripts);
            for (const f of Object.keys(fixResult.scripts)) {
              try { fs.chmodSync(path.join(scriptsDir, f), 0o755); } catch {}
            }
            postRefactorResults = runTests(testsDir);

            if (postRefactorResults.failed <= preRefactorResults.failed) {
              scriptsFixed = true;
              log('  Scripts fixed');
            }
          }
        }
      } catch {
        break;
      }
    }

    if (postRefactorResults.failed > preRefactorResults.failed) {
      log('  Rolling back scripts...');
      syncDir(scriptsDir, currentScripts);
      for (const f of Object.keys(currentScripts)) {
        try { fs.chmodSync(path.join(scriptsDir, f), 0o755); } catch {}
      }
      scriptsRolledBack = true;

      if (memory) {
        await memory.add(
          `Evolution #${evolutionNumber} script refactor rolled back after ${fixAttempt} fix attempts. Tests: ${postRefactorResults.failed} still failing. Output: ${postRefactorResults.output.substring(0, 300)}`,
          { category: 'lesson', importance: 0.9, source: 'evolution' }
        ).catch(() => {});
      }
    }
  }

  log('Archiving previous soul...');
  fs.mkdirSync(archiveDir, { recursive: true });
  if (currentSoul) {
    const timestamp = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(archiveDir, `SOUL-v${state.evolutionCount}-${timestamp}.md`),
      currentSoul
    );
  }

  log('Writing new soul...');
  fs.writeFileSync(soulPath, result.soul);
  if (supabaseConfig) {
    const { backup } = require('../soul');
    backup(supabaseConfig, `soul-v${state.evolutionCount}`, result.soul).catch(e =>
      console.error('[evolve] Soul backup failed:', e.message)
    );
  }

  if (result.user && result.user.length > 50) {
    log('Writing USER.md...');
    fs.writeFileSync(userPath, result.user);
  }

  if (result.agents && result.agents.length > 50) {
    log('Writing AGENTS.md...');
    fs.writeFileSync(agentsPath, result.agents);
  }

  if (result.commands && typeof result.commands === 'object') {
    if (Object.keys(result.commands).length > 0 || Object.keys(currentCommands).length > 0) {
      log(`Writing ${Object.keys(result.commands).length} commands...`);
      syncDir(commandsDir, result.commands);
    }
  }

  log('Building and deploying apps...');
  const deployedApps = await buildAndDeployApps(result, baseDir);

  if (result.dependencies && Array.isArray(result.dependencies) && result.dependencies.length > 0) {
    log(`Installing dependencies: ${result.dependencies.join(', ')}...`);
    try {
      const validDeps = result.dependencies.filter(isValidNpmPackage);
      if (validDeps.length === 0) throw new Error('No valid package names found');
      execFileSync('npm', ['install', '--save', ...validDeps], {
        encoding: 'utf-8',
        timeout: 60000,
        cwd: path.dirname(require.resolve('obol/package.json')),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (memory) {
        await memory.add(
          `Evolution #${evolutionNumber}: failed to install dependencies: ${result.dependencies.join(', ')}. Error: ${e.message.substring(0, 200)}`,
          { category: 'lesson', importance: 0.7, source: 'evolution' }
        ).catch(() => {});
      }
    }
  }

  state.evolutionCount = evolutionNumber;
  state.lastEvolution = new Date().toISOString();
  saveEvolutionState(state, userDir);

  if (memory) {
    log('Saving evolution memory...');
    const changelog = result.changelog || `Evolution #${evolutionNumber} completed.`;
    const rollbackNote = scriptsRolledBack ? ' Scripts rolled back due to test regression.' : scriptsFixed ? ' Scripts fixed after test regression.' : '';
    await memory.add(
      `Soul evolution #${evolutionNumber}: ${changelog}${rollbackNote}`,
      { category: 'event', importance: 0.8, source: 'evolution' }
    ).catch(() => {});

    if (growthReport) {
      await memory.add(
        growthReport.substring(0, 2000),
        { category: 'pattern', importance: 0.7, tags: ['evolution', 'growth-report'], source: `evolution-${evolutionNumber}` }
      ).catch(() => {});
    }
  }

  log('Post-evolution backup...');
  await backupSnapshot(`post-evolution #${evolutionNumber}`, userDir);

  log('Done');
  return {
    evolutionNumber,
    previousLength: currentSoul.length,
    newLength: result.soul.length,
    changelog: result.changelog || null,
    scriptsRolledBack,
    scriptsFixed,
    upgrades: result.upgrades || [],
    deployedApps,
    archived: `SOUL-v${state.evolutionCount - 1}-${new Date().toISOString().slice(0, 10)}.md`,
  };
}

module.exports = { evolve };
