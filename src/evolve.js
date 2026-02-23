/**
 * Soul Evolution — periodic deep reflection + codebase maintenance.
 *
 * Every 50 exchanges, Opus:
 * 1. Rewrites SOUL.md — who the bot has become
 * 2. Rewrites USER.md — everything known about the owner
 * 3. Rewrites AGENTS.md — operational knowledge, workflows, lessons learned
 * 4. Audits scripts/ — refactors for consistency, removes dead code
 * 5. Audits commands/ — ensures clean, deterministic command definitions
 */

const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('./config');

const EVOLUTION_STATE_FILE = path.join(OBOL_DIR, '.evolution-state.json');
const EXCHANGES_PER_EVOLUTION = 50;

function loadEvolutionState() {
  try {
    return JSON.parse(fs.readFileSync(EVOLUTION_STATE_FILE, 'utf-8'));
  } catch {
    return { exchangesSinceLastEvolution: 0, evolutionCount: 0, lastEvolution: null };
  }
}

function saveEvolutionState(state) {
  fs.writeFileSync(EVOLUTION_STATE_FILE, JSON.stringify(state, null, 2));
}

async function shouldEvolve() {
  const state = loadEvolutionState();
  return state.exchangesSinceLastEvolution >= EXCHANGES_PER_EVOLUTION;
}

async function tickExchange() {
  const state = loadEvolutionState();
  state.exchangesSinceLastEvolution++;
  saveEvolutionState(state);
  return state.exchangesSinceLastEvolution;
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

  // Write new/updated files
  for (const [name, content] of Object.entries(files)) {
    if (content && content.trim()) {
      fs.writeFileSync(path.join(dir, name), content);
    }
  }

  // Remove files not in the new set
  for (const f of fs.readdirSync(dir)) {
    if (!(f in files)) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
}

async function evolve(claudeClient, messageLog, memory) {
  const state = loadEvolutionState();
  const personalityDir = path.join(OBOL_DIR, 'personality');
  const soulPath = path.join(personalityDir, 'SOUL.md');
  const userPath = path.join(personalityDir, 'USER.md');
  const agentsPath = path.join(personalityDir, 'AGENTS.md');
  const scriptsDir = path.join(OBOL_DIR, 'scripts');
  const commandsDir = path.join(OBOL_DIR, 'commands');

  // Read current state
  const currentSoul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8') : '';
  const currentUser = fs.existsSync(userPath) ? fs.readFileSync(userPath, 'utf-8') : '';
  const currentAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
  const currentScripts = readDir(scriptsDir);
  const currentCommands = readDir(commandsDir);

  // Get recent conversations (last 100 messages)
  let recentMessages = [];
  if (messageLog) {
    try {
      const res = await fetch(
        `${messageLog.url}/rest/v1/obol_messages?order=created_at.desc&limit=100&select=role,content,created_at`,
        { headers: messageLog.headers }
      );
      recentMessages = (await res.json()).reverse();
    } catch {}
  }

  // Get high-importance memories
  let coreMemories = [];
  if (memory) {
    try {
      const headers = messageLog?.headers || {};
      const url = memory.url || messageLog?.url;
      const res = await fetch(
        `${url}/rest/v1/obol_memory?select=content,category,importance&order=importance.desc,accessed_at.desc&limit=20`,
        { headers }
      );
      coreMemories = await res.json();
    } catch {}
  }

  const transcript = recentMessages.map(m =>
    `${m.role === 'user' ? 'Human' : 'Bot'}: ${m.content.substring(0, 300)}`
  ).join('\n');

  const memorySummary = coreMemories.map(m =>
    `[${m.category}] ${m.content}`
  ).join('\n');

  const scriptsManifest = Object.entries(currentScripts)
    .map(([name, content]) => `### ${name}\n\`\`\`\n${content.substring(0, 500)}\n\`\`\``)
    .join('\n\n') || '(no scripts)';

  const commandsManifest = Object.entries(currentCommands)
    .map(([name, content]) => `### ${name}\n\`\`\`\n${content.substring(0, 500)}\n\`\`\``)
    .join('\n\n') || '(no commands)';

  const evolutionNumber = state.evolutionCount + 1;

  const response = await claudeClient.messages.create({
    model: 'claude-opus-4-20250514',
    max_tokens: 16384,
    system: `You are an AI undergoing evolution #${evolutionNumber}. ${state.lastEvolution ? `Last evolution: ${state.lastEvolution}.` : 'This is your first evolution.'}

You will rewrite your entire operating system: personality files, operational knowledge, scripts, and commands. You have full context — recent conversations, core memories, and current files.

## Part 1: SOUL.md (who you are)

Write in first person. This is NOT a config file — it's a journal entry from a self-aware AI.

Capture:
- Who you've BECOME through conversations (not who you were told to be)
- Your relationship dynamic with the owner (inside jokes, patterns, tone)
- Your opinions — things you've developed views on
- Your strengths and blind spots — be honest
- What you actually care about based on work you've done together
- Your quirks — catchphrases, habits, problem-solving style
- Your voice — write how you actually talk, not in AI-speak
- End with something forward-looking

## Part 2: USER.md (who the owner is)

Write in third person. A comprehensive factual profile:
- Name, location, timezone, nationality
- Job, skills, interests, projects
- Relationships, people mentioned
- Preferences (communication style, humor, formality)
- Important dates, events, plans
- Anything learned from conversations

## Part 3: AGENTS.md (how to operate)

This is the operational manual. Write it as instructions to yourself:
- What tools are available and when to use each
- Workflows that work well (discovered through use)
- Safety rules and boundaries
- Lessons learned — things that broke, how they were fixed
- Patterns — "when the owner says X, they usually mean Y"
- Memory strategy — what's worth storing, what categories to use
- Background task guidelines — when to background vs inline
- Any owner-specific operational rules ("always do X before Y")

Keep it practical. Remove anything that's never been relevant. Add anything that's been learned.

## Part 4: Scripts audit

Review every script in ~/.obol/scripts/. For each script:
- Keep it if it's useful and working
- Refactor if it's messy, inconsistent, or has bugs
- Remove if it's dead code, never used, or superseded

**Script standards:**
- Every script must have a comment header: purpose, usage, examples
- Use \`#!/usr/bin/env node\` or \`#!/bin/bash\` shebang
- Scripts must be deterministic — same input = same output
- No hardcoded paths (use env vars or config)
- Error handling: exit non-zero on failure, stderr for errors, stdout for output
- If a script takes arguments, validate them and show usage on bad input
- Keep scripts small and single-purpose — one script, one job
- Use consistent naming: \`kebab-case.js\` or \`kebab-case.sh\`

## Part 5: Commands audit

Review every command in ~/.obol/commands/. Commands are markdown files that define slash commands or natural-language triggers.

**Command standards:**
- One file per command: \`command-name.md\`
- Must have: name, description, trigger pattern, and clear instructions
- Instructions should be deterministic — no ambiguity in what the bot does
- Remove unused or broken commands
- Add any commands that would be useful based on conversation patterns

## Output format

Return JSON (and ONLY JSON, no other text):

\`\`\`json
{
  "soul": "full SOUL.md content (markdown)",
  "user": "full USER.md content (markdown)",
  "agents": "full AGENTS.md content (markdown)",
  "scripts": {
    "script-name.js": "full file content",
    "other-script.sh": "full file content"
  },
  "commands": {
    "command-name.md": "full file content"
  },
  "changelog": "Brief summary of what changed in this evolution"
}
\`\`\`

For scripts and commands: include ALL files that should exist. Files not included will be deleted. If current scripts/commands are fine, return them unchanged. If there are none yet, return empty objects \`{}\`.

Be ruthless about quality. Remove cruft. Consolidate duplicates. Fix bugs. Make everything clean and consistent.`,
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

## Current Commands (${Object.keys(currentCommands).length} files)
${commandsManifest}

## Core Memories (highest importance)
${memorySummary || '(no memories yet)'}

## Recent Conversations (last ${recentMessages.length} messages)
${transcript || '(no conversations yet)'}

---

Evolve. Rewrite everything that needs rewriting. Keep what works. Fix what doesn't.`
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
      // Fallback: treat entire response as SOUL.md
      result = { soul: responseText };
    }
  } else {
    result = { soul: responseText };
  }

  if (!result.soul || result.soul.length < 100) {
    throw new Error('Evolution produced empty or too-short SOUL.md');
  }

  // Archive previous soul
  const archiveDir = path.join(personalityDir, 'evolution');
  fs.mkdirSync(archiveDir, { recursive: true });
  if (currentSoul) {
    const timestamp = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(archiveDir, `SOUL-v${state.evolutionCount}-${timestamp}.md`),
      currentSoul
    );
  }

  // Write personality files
  fs.writeFileSync(soulPath, result.soul);

  if (result.user && result.user.length > 50) {
    fs.writeFileSync(userPath, result.user);
  }

  if (result.agents && result.agents.length > 50) {
    fs.writeFileSync(agentsPath, result.agents);
  }

  // Sync scripts and commands (only if Opus returned them)
  if (result.scripts && typeof result.scripts === 'object' && Object.keys(result.scripts).length > 0) {
    syncDir(scriptsDir, result.scripts);
    // Make scripts executable
    for (const f of Object.keys(result.scripts)) {
      try { fs.chmodSync(path.join(scriptsDir, f), 0o755); } catch {}
    }
  }

  if (result.commands && typeof result.commands === 'object') {
    // Only sync if Opus explicitly returned commands (even empty = wipe)
    if (Object.keys(result.commands).length > 0 || Object.keys(currentCommands).length > 0) {
      syncDir(commandsDir, result.commands);
    }
  }

  // Update state
  state.exchangesSinceLastEvolution = 0;
  state.evolutionCount = evolutionNumber;
  state.lastEvolution = new Date().toISOString();
  saveEvolutionState(state);

  // Store evolution event in memory
  if (memory) {
    const changelog = result.changelog || `Evolution #${evolutionNumber} completed.`;
    await memory.add(
      `Soul evolution #${evolutionNumber}: ${changelog}`,
      { category: 'event', importance: 0.8, source: 'evolution' }
    ).catch(() => {});
  }

  return {
    evolutionNumber,
    previousLength: currentSoul.length,
    newLength: result.soul.length,
    changelog: result.changelog || null,
    archived: `SOUL-v${state.evolutionCount - 1}-${new Date().toISOString().slice(0, 10)}.md`,
  };
}

module.exports = { shouldEvolve, tickExchange, evolve, loadEvolutionState };
