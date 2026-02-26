const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { OBOL_DIR } = require('../config');
const { loadTraits, saveTraits } = require('../personality');
const { isValidNpmPackage } = require('../sanitize');
const { loadEvolutionState, saveEvolutionState } = require('./state');
const { readDir, syncDir } = require('./filesystem');
const { runTests } = require('./tests');
const { backupSnapshot } = require('./backup');
const { deepConsolidateMemory } = require('./memory');
const { buildAndDeployApps } = require('./apps');

const MODELS = {
  personality: 'claude-sonnet-4-6',
  code: 'claude-sonnet-4-6',
  codeFix: 'claude-sonnet-4-6',
};
const MAX_FIX_ATTEMPTS = 1;

async function evolve(claudeClient, messageLog, memory, userDir) {
  const baseDir = userDir || OBOL_DIR;
  const state = loadEvolutionState(userDir);
  const personalityDir = path.join(baseDir, 'personality');
  const soulPath = path.join(personalityDir, 'SOUL.md');
  const userPath = path.join(personalityDir, 'USER.md');
  const agentsPath = path.join(personalityDir, 'AGENTS.md');
  const scriptsDir = path.join(baseDir, 'scripts');
  const testsDir = path.join(baseDir, 'tests');
  const commandsDir = path.join(baseDir, 'commands');

  const currentSoul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8') : '';
  const currentUser = fs.existsSync(userPath) ? fs.readFileSync(userPath, 'utf-8') : '';
  const currentAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
  const currentTraits = loadTraits(personalityDir);
  const currentScripts = readDir(scriptsDir);
  const currentTests = readDir(testsDir);
  const currentCommands = readDir(commandsDir);

  let recentMessages = [];
  if (messageLog) {
    try {
      const userFilter = messageLog.userId ? `&user_id=eq.${messageLog.userId}` : '';
      const sinceFilter = state.lastEvolution ? `&created_at=gt.${state.lastEvolution}` : '';
      const res = await fetch(
        `${messageLog.url}/rest/v1/obol_messages?order=created_at.asc&limit=500&select=role,content,created_at${userFilter}${sinceFilter}`,
        { headers: messageLog.headers }
      );
      recentMessages = await res.json();
    } catch (e) {
      console.error('[evolve] Failed to fetch recent messages:', e.message);
    }
  }

  let coreMemories = [];
  if (memory) {
    try {
      const headers = messageLog?.headers || {};
      const url = messageLog?.url;
      if (!url) throw new Error('No Supabase URL available');
      const memUserFilter = messageLog?.userId ? `&user_id=eq.${messageLog.userId}` : '';
      const res = await fetch(
        `${url}/rest/v1/obol_memory?select=content,category,importance&order=importance.desc,accessed_at.desc&limit=20${memUserFilter}`,
        { headers }
      );
      coreMemories = await res.json();
    } catch (e) {
      console.error('[evolve] Failed to fetch core memories:', e.message);
    }
  }

  let recentMemories = [];
  if (memory) {
    try {
      const headers = messageLog?.headers || {};
      const url = messageLog?.url;
      if (url) {
        const memUserFilter = messageLog?.userId ? `&user_id=eq.${messageLog.userId}` : '';
        const sinceFilter = state.lastEvolution ? `&created_at=gt.${state.lastEvolution}` : '';
        const res = await fetch(
          `${url}/rest/v1/obol_memory?select=content,category,importance,tags,created_at,source&order=created_at.asc&limit=100${memUserFilter}${sinceFilter}`,
          { headers }
        );
        recentMemories = await res.json();
      }
    } catch (e) {
      console.error('[evolve] Failed to fetch recent memories:', e.message);
    }
  }

  let previousSoul = '';
  const archiveDir = path.join(personalityDir, 'evolution');
  try {
    if (fs.existsSync(archiveDir)) {
      const archives = fs.readdirSync(archiveDir)
        .filter(f => f.startsWith('SOUL-v') && f.endsWith('.md'))
        .sort();
      if (archives.length > 0) {
        previousSoul = fs.readFileSync(path.join(archiveDir, archives[archives.length - 1]), 'utf-8');
      }
    }
  } catch {}

  const transcript = recentMessages.map(m =>
    `${m.role === 'user' ? 'Human' : 'Bot'}: ${m.content.substring(0, 600)}`
  ).join('\n');

  const categoryLabels = {
    person: 'People', decision: 'Decisions', preference: 'Preferences',
    lesson: 'Lessons', project: 'Projects', fact: 'Facts',
    event: 'Events', pattern: 'Patterns', context: 'Context',
  };

  const memoryGroups = {};
  for (const m of coreMemories) {
    const group = categoryLabels[m.category] || 'Other';
    if (!memoryGroups[group]) memoryGroups[group] = [];
    memoryGroups[group].push(m.content);
  }
  const memorySummary = Object.entries(memoryGroups)
    .map(([group, items]) => `### ${group}\n${items.map(i => `- ${i}`).join('\n')}`)
    .join('\n\n');

  const recentMemoryGroups = {};
  for (const m of recentMemories) {
    const group = categoryLabels[m.category] || 'Other';
    if (!recentMemoryGroups[group]) recentMemoryGroups[group] = [];
    const date = m.created_at ? new Date(m.created_at).toISOString().slice(0, 10) : '?';
    const sourceTag = m.source ? ` [${m.source}]` : '';
    recentMemoryGroups[group].push(`${m.content} _(${date}${sourceTag})_`);
  }
  const recentMemorySummary = Object.entries(recentMemoryGroups)
    .map(([group, items]) => `### ${group}\n${items.map(i => `- ${i}`).join('\n')}`)
    .join('\n\n');

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

  await backupSnapshot(`pre-evolution #${evolutionNumber}`, userDir);

  if (memory && recentMessages.length >= 4) {
    await deepConsolidateMemory(claudeClient, memory, recentMessages, evolutionNumber, MODELS.personality).catch(e =>
      console.error('[evolve] Deep consolidation failed:', e.message)
    );
  }

  const isFirstEvolution = !currentSoul;
  let growthReport = '';
  if (!isFirstEvolution && (recentMemories.length > 0 || recentMessages.length > 0)) {
    try {
      const growthResponse = await claudeClient.messages.create({
        model: MODELS.personality,
        max_tokens: 2048,
        system: `You are analyzing an AI personality's growth between evolutions. Compare who the AI was (previous SOUL) against who it is now (current SOUL), incorporating new memories and conversations since the last evolution.

Produce a structured growth report covering:

1. NEW LEARNINGS — What new facts, skills, or knowledge emerged
2. RELATIONSHIP SHIFTS — How the dynamic with the owner changed (closer, more trust, new friction, etc.)
3. BEHAVIORAL PATTERNS — Recurring interaction styles or habits observed
4. GROWTH EDGES — Areas where the personality is being pushed or pulled in new directions
5. TRAIT PRESSURE — Which traits should shift and why (cite specific evidence from conversations/memories)
6. IDENTITY CONTINUITY — What core aspects stayed the same and should be preserved

Be specific. Cite evidence from the conversations and memories. This report guides the evolution rewrite.`,
        messages: [{
          role: 'user',
          content: `## Previous SOUL (before current evolution)
${previousSoul || '(not available)'}

## Current SOUL
${currentSoul || '(empty)'}

## Current Traits
${JSON.stringify(currentTraits)}

## New Memories Since Last Evolution (${recentMemories.length})
${recentMemorySummary || '(none)'}

## Recent Conversations (${recentMessages.length} messages)
${transcript.substring(0, 30000)}`,
        }],
      });
      growthReport = growthResponse.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    } catch (e) {
      console.error('[evolve] Growth analysis failed:', e.message);
    }
  }

  const baselineResults = runTests(testsDir);

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
    currentTraits,
    baselineResults,
  });

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

${recentMemorySummary ? `## New Memories Since Last Evolution (${recentMemories.length})\n${recentMemorySummary}\n\n` : ''}## Recent Conversations (last ${recentMessages.length} messages)
${transcript || '(no conversations yet)'}

---

Evolve. Rewrite everything that needs rewriting. Write tests for every script. Keep what works. Fix what doesn't.${growthReport ? ' Use the growth report to guide personality continuity and trait adjustments.' : ''}`
    }],
  });

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

  let scriptsRolledBack = false;
  const hasNewTests = result.tests && typeof result.tests === 'object' && Object.keys(result.tests).length > 0;
  const hasNewScripts = result.scripts && typeof result.scripts === 'object' && Object.keys(result.scripts).length > 0;

  if (hasNewTests) {
    syncDir(testsDir, result.tests);
    for (const f of Object.keys(result.tests)) {
      try { fs.chmodSync(path.join(testsDir, f), 0o755); } catch {}
    }
  }

  const preRefactorResults = hasNewTests ? runTests(testsDir) : baselineResults;

  if (hasNewScripts) {
    syncDir(scriptsDir, result.scripts);
    for (const f of Object.keys(result.scripts)) {
      try { fs.chmodSync(path.join(scriptsDir, f), 0o755); } catch {}
    }
  }

  let scriptsFixed = false;

  if (hasNewTests || hasNewScripts) {
    let postRefactorResults = runTests(testsDir);

    let fixAttempt = 0;
    while (postRefactorResults.failed > preRefactorResults.failed && fixAttempt < MAX_FIX_ATTEMPTS) {
      fixAttempt++;

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
            }
          }
        }
      } catch {
        break;
      }
    }

    if (postRefactorResults.failed > preRefactorResults.failed) {
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

  fs.mkdirSync(archiveDir, { recursive: true });
  if (currentSoul) {
    const timestamp = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(archiveDir, `SOUL-v${state.evolutionCount}-${timestamp}.md`),
      currentSoul
    );
  }

  fs.writeFileSync(soulPath, result.soul);

  if (result.user && result.user.length > 50) {
    fs.writeFileSync(userPath, result.user);
  }

  if (result.agents && result.agents.length > 50) {
    fs.writeFileSync(agentsPath, result.agents);
  }

  if (result.traits && typeof result.traits === 'object') {
    const validTraits = {};
    for (const [key, val] of Object.entries(result.traits)) {
      if (typeof val === 'number' && val >= 0 && val <= 100) {
        validTraits[key] = Math.round(val);
      }
    }
    if (Object.keys(validTraits).length > 0) {
      const merged = { ...currentTraits, ...validTraits };
      saveTraits(personalityDir, merged);
    }
  }

  if (result.commands && typeof result.commands === 'object') {
    if (Object.keys(result.commands).length > 0 || Object.keys(currentCommands).length > 0) {
      syncDir(commandsDir, result.commands);
    }
  }

  const deployedApps = await buildAndDeployApps(result, baseDir);

  if (result.dependencies && Array.isArray(result.dependencies) && result.dependencies.length > 0) {
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

  await backupSnapshot(`post-evolution #${evolutionNumber}`, userDir);

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
