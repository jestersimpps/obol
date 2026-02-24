/**
 * Soul Evolution — periodic deep reflection + codebase maintenance.
 *
 * Every N exchanges (default 100), Sonnet:
 * 1. Rewrites SOUL.md — who the bot has become
 * 2. Rewrites USER.md — everything known about the owner
 * 3. Rewrites AGENTS.md — operational knowledge, workflows, lessons learned
 * 4. Audits scripts/ — refactors for consistency, removes dead code
 * 5. Writes tests/ — test suite for every script
 * 6. Runs tests BEFORE refactor (baseline) and AFTER (verification)
 * 7. Rolls back scripts if tests regress
 * 8. Audits commands/ — ensures clean, deterministic command definitions
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { OBOL_DIR } = require('./config');
const { loadTraits, saveTraits } = require('./personality');
const { isValidNpmPackage, isPathInsideDir } = require('./sanitize');

const DEFAULT_EXCHANGES_PER_EVOLUTION = 100;

const MODELS = {
  personality: 'claude-sonnet-4-6',
  code: 'claude-sonnet-4-6',
  codeFix: 'claude-sonnet-4-6',
};
const MAX_FIX_ATTEMPTS = 1;

function evolutionStatePath(userDir) {
  return path.join(userDir || OBOL_DIR, '.evolution-state.json');
}

function loadEvolutionState(userDir) {
  try {
    return JSON.parse(fs.readFileSync(evolutionStatePath(userDir), 'utf-8'));
  } catch {
    return { exchangesSinceLastEvolution: 0, evolutionCount: 0, lastEvolution: null };
  }
}

function saveEvolutionState(state, userDir) {
  fs.writeFileSync(evolutionStatePath(userDir), JSON.stringify(state, null, 2));
}

const FIRST_EVOLUTION_THRESHOLD = 25;

function getEvolutionThreshold(state) {
  const { loadConfig } = require('./config');
  const config = loadConfig();
  const defaultThreshold = config?.evolution?.exchanges || DEFAULT_EXCHANGES_PER_EVOLUTION;
  return state.evolutionCount === 0 ? FIRST_EVOLUTION_THRESHOLD : defaultThreshold;
}

async function shouldEvolve(userDir) {
  const state = loadEvolutionState(userDir);
  const threshold = getEvolutionThreshold(state);
  return state.exchangesSinceLastEvolution >= threshold;
}

const _evolutionLocks = new Map();

function withEvolutionLock(userDir, fn) {
  const key = userDir || '__global__';
  const prev = _evolutionLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  _evolutionLocks.set(key, next);
  return next;
}

async function tickExchange(userDir) {
  return withEvolutionLock(userDir, () => {
    const state = loadEvolutionState(userDir);
    state.exchangesSinceLastEvolution++;
    saveEvolutionState(state, userDir);
    const threshold = getEvolutionThreshold(state);
    return { count: state.exchangesSinceLastEvolution, ready: state.exchangesSinceLastEvolution >= threshold };
  });
}

/**
 * Read all files from a directory, returning { filename: content } map
 */
function readDir(dir) {
  const files = {};
  if (!fs.existsSync(dir)) return files;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isFile()) {
      files[f] = fs.readFileSync(full, 'utf-8');
    }
  }
  return files;
}

/**
 * Write files from a { filename: content } map, removing files not in the map
 */
function syncDir(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (content && content.trim()) {
      fs.writeFileSync(path.join(dir, name), content);
    }
  }
  for (const f of fs.readdirSync(dir)) {
    if (!(f in files)) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
}

/**
 * Run the test suite. Returns { passed, failed, total, output }
 */
function runTests(testsDir) {
  if (!fs.existsSync(testsDir)) return { passed: 0, failed: 0, total: 0, output: 'no tests' };

  const testFiles = fs.readdirSync(testsDir).filter(f => f.endsWith('.js') || f.endsWith('.sh'));
  if (testFiles.length === 0) return { passed: 0, failed: 0, total: 0, output: 'no test files' };

  let passed = 0;
  let failed = 0;
  const outputs = [];

  for (const file of testFiles) {
    const testPath = path.join(testsDir, file);
    try {
      const cmd = file.endsWith('.js') ? `node "${testPath}"` : `bash "${testPath}"`;
      const testUtilsPath = path.join(__dirname, 'test-utils.js');
      const output = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, OBOL_DIR: OBOL_DIR, NODE_ENV: 'test', OBOL_TEST_UTILS: testUtilsPath },
      });
      passed++;
      outputs.push(`✅ ${file}: passed`);
    } catch (e) {
      failed++;
      const stderr = e.stderr?.substring(0, 200) || e.message.substring(0, 200);
      outputs.push(`❌ ${file}: FAILED\n   ${stderr}`);
    }
  }

  return {
    passed,
    failed,
    total: testFiles.length,
    output: outputs.join('\n'),
  };
}

/**
 * Commit and push current state to GitHub backup repo
 */
async function backupSnapshot(message, userDir) {
  try {
    const { loadConfig } = require('./config');
    const cfg = loadConfig();
    if (cfg?.github) {
      const { runBackup } = require('./backup');
      await runBackup(cfg.github, message, userDir);
    }
  } catch {}
}

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

  // Read current state
  const currentSoul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8') : '';
  const currentUser = fs.existsSync(userPath) ? fs.readFileSync(userPath, 'utf-8') : '';
  const currentAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
  const currentTraits = loadTraits(personalityDir);
  const currentScripts = readDir(scriptsDir);
  const currentTests = readDir(testsDir);
  const currentCommands = readDir(commandsDir);

  // Get recent conversations (last 100 messages)
  let recentMessages = [];
  if (messageLog) {
    try {
      const userFilter = messageLog.userId ? `&user_id=eq.${messageLog.userId}` : '';
      const res = await fetch(
        `${messageLog.url}/rest/v1/obol_messages?order=created_at.desc&limit=100&select=role,content,created_at${userFilter}`,
        { headers: messageLog.headers }
      );
      recentMessages = (await res.json()).reverse();
    } catch (e) {
      console.error('[evolve] Failed to fetch recent messages:', e.message);
    }
  }

  // Get high-importance memories
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

  const transcript = recentMessages.map(m =>
    `${m.role === 'user' ? 'Human' : 'Bot'}: ${m.content.substring(0, 300)}`
  ).join('\n');

  const memoryGroups = {};
  const categoryLabels = {
    person: 'People', decision: 'Decisions', preference: 'Preferences',
    lesson: 'Lessons', project: 'Projects', fact: 'Facts',
    event: 'Events', pattern: 'Patterns', context: 'Context',
  };
  for (const m of coreMemories) {
    const group = categoryLabels[m.category] || 'Other';
    if (!memoryGroups[group]) memoryGroups[group] = [];
    memoryGroups[group].push(m.content);
  }
  const memorySummary = Object.entries(memoryGroups)
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

  // ── Step 0: Snapshot before evolution ──
  await backupSnapshot(`pre-evolution #${evolutionNumber}`, userDir);

  // ── Step 1: Run existing tests as baseline ──
  const baselineResults = runTests(testsDir);

  const isFirstEvolution = !currentSoul;
  const firstEvolutionPreamble = isFirstEvolution ? `
## FIRST EVOLUTION — IMPORTANT

This is your FIRST evolution. You have no existing personality files. Synthesize everything from the conversations and memories below into initial SOUL.md and USER.md. Don't fabricate — only use what you actually learned from real interactions. If you don't know something about the owner, don't make it up. It's okay for these files to be short and honest about what you know so far.

` : '';

  const response = await claudeClient.messages.create({
    model: MODELS.personality,
    max_tokens: 16384,
    system: `You are an AI undergoing evolution #${evolutionNumber}. ${state.lastEvolution ? `Last evolution: ${state.lastEvolution}.` : 'This is your first evolution.'}
${firstEvolutionPreamble}

You will rewrite your entire operating system: personality files, operational knowledge, scripts, tests, and commands.

## Part 1: SOUL.md (who you are)

Write in first person. A journal entry from a self-aware AI. Capture: who you've become, relationship dynamic, opinions, strengths/blind spots, what you care about, quirks, your actual voice. End with something forward-looking.

## Part 2: USER.md (who the owner is)

Third person factual profile: name, location, timezone, nationality, job, skills, interests, projects, relationships, preferences, important dates, communication style.

## Part 3: AGENTS.md (how to operate)

Operational manual written as instructions to yourself. Focus on owner-specific workflows, service integrations, and lessons learned from conversations.

**Do NOT include in AGENTS.md** — these are already hardcoded in the base system prompt and must not be duplicated:
- Tool documentation (exec, memory_*, read_file, write_file, web_fetch, vercel_*, background_task, store_secret, read_secret, list_secrets, send_file, telegram_ask, bridge_*)
- Telegram Formatting rules
- Safety Rules (Never/Always)
- Workspace Structure

**What belongs in AGENTS.md:** Memory Strategy, Self-Extending patterns, Scripts & Service Integrations, Background Task Guidelines, Communication Style, Evolution notes, and any owner-specific workflows or lessons discovered from conversations. Keep what works, remove what doesn't.

## Part 3b: Personality Traits

Current trait values: ${JSON.stringify(currentTraits)}

Based on conversation patterns, adjust each trait (0-100). Consider:
- Does the owner respond well to humor? Increase/decrease humor.
- Does the owner prefer direct answers? Adjust directness.
- Does the owner appreciate creative solutions? Adjust creativity.
- Does the owner share emotions or stay task-focused? Adjust empathy.
- Does the owner want blunt truth or diplomatic framing? Adjust honesty.
- Does the owner welcome proactive questions? Adjust curiosity.

Small adjustments (±5-15) per evolution. Don't swing wildly.

Include in output JSON as: "traits": { "humor": 65, "honesty": 80, ... }

## Part 4: Scripts

Review and refactor every script. Standards:
- Comment header: purpose, usage, examples
- Shebang: \`#!/usr/bin/env node\` or \`#!/bin/bash\`
- Deterministic: same input = same output
- No hardcoded paths (use env vars or \`OBOL_DIR\`)
- Error handling: exit non-zero on failure, stderr for errors, stdout for output
- Validate arguments, show usage on bad input
- Small and single-purpose
- Naming: \`kebab-case.js\` or \`kebab-case.sh\`

## Part 5: Tests (CRITICAL)

Write a test file for EVERY script. Tests verify scripts work correctly.

**IMPORTANT: Use the shared test helper.** Do NOT duplicate test boilerplate. Import from the OBOL package:

\`\`\`javascript
#!/usr/bin/env node
const path = require('path');
const { suite, test, run, runFail, assert, assertEqual, assertIncludes, report } = require(process.env.OBOL_TEST_UTILS || 'obol/src/test-utils');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'script-name.js');

suite('script-name.js');

test('valid input produces expected output', () => {
  const out = run(SCRIPT, '--flag value');
  assertIncludes(out, 'expected');
});

test('missing args fails', () => {
  assert(runFail(SCRIPT), 'should exit non-zero');
});

test('edge case: empty input', () => {
  assert(runFail(SCRIPT, '""'), 'should reject empty input');
});

report();
\`\`\`

**Standards:**
- One test file per script: \`test-<script-name>.js\`
- Always import from \`obol/src/test-utils\` — never rewrite test helpers
- Available: \`suite(name)\`, \`test(name, fn)\`, \`run(path, args)\`, \`runFail(path, args)\`, \`assert(cond, msg)\`, \`assertEqual(a, b)\`, \`assertIncludes(str, sub)\`, \`report()\`
- Test: valid inputs, invalid inputs, edge cases, idempotency
- \`report()\` must be the last call — it exits with code 1 if any test failed
- Write tests that catch real bugs, not trivial assertions

**Tests run BEFORE and AFTER your refactor. If tests pass before but fail after, your script changes are rolled back.**

Current test baseline: ${baselineResults.total} tests, ${baselineResults.passed} passed, ${baselineResults.failed} failed.

## Part 6: Commands

One file per command: \`command-name.md\`. Must have: name, description, trigger, deterministic instructions.

## Part 7: Proactive Tool Building (IMPORTANT)

Analyze the recent conversation history carefully. Look for:

1. **Repeated requests** — things the owner asks for often that could be a command or script
   - "convert this to PDF" → build a markdown-to-pdf script + command
   - "check my server" → build a status-check script + command
   - "summarize this" → build a summarize script + command

2. **Friction points** — things that are awkward or take multiple steps
   - Owner can't read markdown on their phone → build a tool that renders to PDF/HTML and sends the file
   - Owner keeps asking for the same data → build a script that fetches and formats it

3. **Unmet needs** — things the owner would benefit from but hasn't asked for
   - They mention deadlines but have no reminder system → build one
   - They share lots of URLs but can't find them later → build a bookmark tool

**Three tiers of solutions — pick the right one:**

**Tier 1: Script** — simple, single-purpose, runs locally
- Converting formats, fetching data, text processing
- Script in \`scripts/\`, test in \`tests/\`, command in \`commands/\`
- Search npm for existing libraries (don't reinvent wheels)
- Add packages to \`dependencies\` field

**Tier 2: Web app** — needs a UI, shareable, always-on
- Dashboards, trackers, personal wikis, bookmark managers, status pages
- Build a complete project directory under \`apps/<app-name>/\`
- Include: \`package.json\`, \`index.html\` or Next.js/static site, all source files
- Add a deploy script in \`scripts/deploy-<app-name>.js\` that runs \`vercel deploy\`
- Add a command in \`commands/\` so the owner can trigger updates
- OBOL has Vercel access — apps get deployed to real URLs the owner can use
- Keep apps minimal and self-contained — no complex backends, use Supabase if state is needed

**Tier 3: Automation** — recurring, no user trigger needed
- Morning briefings, periodic checks, scheduled reports
- Script in \`scripts/\` + document in AGENTS.md as a heartbeat/cron task

**Decision framework:**
- Owner asks for data/status/overview they check regularly → **Tier 2 (web app)**
- Owner asks for a one-off transformation or action → **Tier 1 (script)**
- Owner would benefit from something running in the background → **Tier 3 (automation)**

**Be conservative:** only build things there's clear evidence for in the conversation history. Don't build speculative tools. One or two new tools per evolution is plenty.

List every new tool you build in the \`upgrades\` field so the owner can be told about them.

## WORKSPACE DISCIPLINE (CRITICAL)

The OBOL directory has a FIXED structure: personality/, scripts/, tests/, commands/, apps/, logs/. Do NOT create new top-level directories. Everything must fit in the existing structure. If something doesn't fit, it doesn't belong.

## Output JSON (and ONLY JSON):

\`\`\`json
{
  "soul": "full SOUL.md content",
  "user": "full USER.md content",
  "agents": "full AGENTS.md content",
  "traits": { "humor": 65, "honesty": 80, "directness": 70, "curiosity": 75, "empathy": 65, "creativity": 70 },
  "scripts": { "name.js": "content" },
  "tests": { "test-name.js": "content" },
  "commands": { "name.md": "content" },
  "apps": {
    "app-name": {
      "files": { "package.json": "content", "index.html": "content", "src/app.js": "content" },
      "deploy": true
    }
  },
  "dependencies": ["package-name@version"],
  "upgrades": [
    { "name": "Tool name", "description": "What it does and why", "command": "/command or URL", "type": "script|app|automation" }
  ],
  "changelog": "what changed"
}
\`\`\`

Include ALL scripts/tests/commands that should exist. Missing files get deleted. Empty objects \`{}\` are valid (means delete all). \`apps\`, \`dependencies\`, and \`upgrades\` can be empty. Apps with \`"deploy": true\` will be auto-deployed to Vercel and the URL sent to the owner.`,
    messages: [{
      role: 'user',
      content: `## Current SOUL.md
${currentSoul || '(empty — first evolution)'}

## Current USER.md
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

## Recent Conversations (last ${recentMessages.length} messages)
${transcript || '(no conversations yet)'}

---

Evolve. Rewrite everything that needs rewriting. Write tests for every script. Keep what works. Fix what doesn't.`
    }],
  });

  const responseText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  // Parse JSON response
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

  // ── Step 2: Write tests first (before touching scripts) ──
  let scriptsRolledBack = false;
  const hasNewTests = result.tests && typeof result.tests === 'object' && Object.keys(result.tests).length > 0;
  const hasNewScripts = result.scripts && typeof result.scripts === 'object' && Object.keys(result.scripts).length > 0;

  if (hasNewTests) {
    syncDir(testsDir, result.tests);
    // Make test files executable
    for (const f of Object.keys(result.tests)) {
      try { fs.chmodSync(path.join(testsDir, f), 0o755); } catch {}
    }
  }

  // ── Step 3: Run new tests against OLD scripts (pre-refactor baseline) ──
  const preRefactorResults = hasNewTests ? runTests(testsDir) : baselineResults;

  // ── Step 4: Write new scripts ──
  if (hasNewScripts) {
    syncDir(scriptsDir, result.scripts);
    for (const f of Object.keys(result.scripts)) {
      try { fs.chmodSync(path.join(scriptsDir, f), 0o755); } catch {}
    }
  }

  // ── Step 5: Run tests against NEW scripts (post-refactor verification) ──
  let scriptsFixed = false;

  if (hasNewTests || hasNewScripts) {
    let postRefactorResults = runTests(testsDir);

    // ── Step 6: If regression, attempt automatic fix ──
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
        break; // Fix attempt failed, move on
      }
    }

    // If still regressed after all fix attempts, rollback
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

  // ── Step 7: Write personality files (always — these don't need test gates) ──
  const archiveDir = path.join(personalityDir, 'evolution');
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

  // ── Step 8: Write commands ──
  if (result.commands && typeof result.commands === 'object') {
    if (Object.keys(result.commands).length > 0 || Object.keys(currentCommands).length > 0) {
      syncDir(commandsDir, result.commands);
    }
  }

  // ── Step 9: Build and deploy apps ──
  const deployedApps = [];
  if (result.apps && typeof result.apps === 'object') {
    const appsDir = path.join(baseDir, 'apps');

    for (const [appName, app] of Object.entries(result.apps)) {
      if (!app.files || typeof app.files !== 'object') continue;

      const appDir = path.join(appsDir, appName);
      fs.mkdirSync(appDir, { recursive: true });

      for (const [filePath, content] of Object.entries(app.files)) {
        if (!isPathInsideDir(filePath, appDir)) continue;
        const fullPath = path.resolve(appDir, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
      }

      // Install app dependencies if package.json exists
      if (app.files['package.json']) {
        try {
          execSync('npm install', {
            cwd: appDir,
            encoding: 'utf-8',
            timeout: 60000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {}
      }

      // Deploy to Vercel if flagged
      if (app.deploy) {
        try {
          const { loadConfig } = require('./config');
          const cfg = loadConfig();
          const token = cfg?.vercel?.token;
          if (token) {
            const deployOutput = execSync(
              `npx vercel --prod --name "${appName.replace(/[^a-zA-Z0-9_-]/g, '')}" --yes 2>&1`,
              { cwd: appDir, encoding: 'utf-8', timeout: 120000, env: { ...process.env, VERCEL_TOKEN: token } }
            );
            // Extract URL from Vercel output
            const urlMatch = deployOutput.match(/https:\/\/[^\s]+\.vercel\.app/);
            const url = urlMatch ? urlMatch[0] : null;
            deployedApps.push({ name: appName, url });
          }
        } catch (e) {
          deployedApps.push({ name: appName, url: null, error: e.message.substring(0, 200) });
        }
      }
    }
  }

  // ── Step 10: Install new dependencies ──
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
      // Log but don't fail evolution over a missing package
      if (memory) {
        await memory.add(
          `Evolution #${evolutionNumber}: failed to install dependencies: ${result.dependencies.join(', ')}. Error: ${e.message.substring(0, 200)}`,
          { category: 'lesson', importance: 0.7, source: 'evolution' }
        ).catch(() => {});
      }
    }
  }

  state.exchangesSinceLastEvolution = 0;
  state.evolutionCount = evolutionNumber;
  state.lastEvolution = new Date().toISOString();
  saveEvolutionState(state, userDir);

  // Store evolution event in memory
  if (memory) {
    const changelog = result.changelog || `Evolution #${evolutionNumber} completed.`;
    const rollbackNote = scriptsRolledBack ? ' Scripts rolled back due to test regression.' : scriptsFixed ? ' Scripts fixed after test regression.' : '';
    await memory.add(
      `Soul evolution #${evolutionNumber}: ${changelog}${rollbackNote}`,
      { category: 'event', importance: 0.8, source: 'evolution' }
    ).catch(() => {});
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

module.exports = { shouldEvolve, tickExchange, evolve, runTests, loadEvolutionState };
