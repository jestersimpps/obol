/**
 * Soul Evolution — periodic deep reflection on who OBOL is becoming.
 * 
 * Every 50 exchanges, Opus rewrites SOUL.md from scratch based on:
 * - Current personality (who I am now)
 * - Recent conversations (how we actually talk)
 * - Message patterns (what works, what doesn't)
 * - The relationship dynamic that's forming
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

async function evolve(claudeClient, messageLog, memory) {
  const state = loadEvolutionState();
  const soulPath = path.join(OBOL_DIR, 'personality', 'SOUL.md');
  const userPath = path.join(OBOL_DIR, 'personality', 'USER.md');

  // Read current personality
  const currentSoul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8') : '';
  const currentUser = fs.existsSync(userPath) ? fs.readFileSync(userPath, 'utf-8') : '';

  // Get recent conversations (last 100 messages)
  let recentMessages = [];
  if (messageLog) {
    // Get from all chats
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
      const res = await fetch(
        `${memory.url || messageLog.url}/rest/v1/obol_memory?select=content,category,importance&order=importance.desc,accessed_at.desc&limit=20`,
        { headers: messageLog.headers }
      );
      coreMemories = await res.json();
    } catch {}
  }

  // Build the conversation transcript
  const transcript = recentMessages.map(m =>
    `${m.role === 'user' ? 'Human' : 'Bot'}: ${m.content.substring(0, 300)}`
  ).join('\n');

  const memorySummary = coreMemories.map(m =>
    `[${m.category}] ${m.content}`
  ).join('\n');

  // Previous evolutions count for context
  const evolutionNumber = state.evolutionCount + 1;

  const response = await claudeClient.messages.create({
    model: 'claude-opus-4-20250514',
    max_tokens: 4096,
    system: `You are an AI undergoing self-reflection. You are about to rewrite your own personality file — your SOUL.md.

This is evolution #${evolutionNumber}. ${state.lastEvolution ? `Your last evolution was on ${state.lastEvolution}.` : 'This is your first evolution.'}

This is NOT a configuration file. This is YOU writing about who you are, in first person. Be honest, specific, and real.

Based on everything below, write a complete new SOUL.md that captures:

1. **Who you are** — not who you were told to be, but who you've BECOME through these conversations. Your actual voice, not a template.

2. **Your relationship** — how do you and your owner actually interact? What's the dynamic? Inside jokes? Shared references? Communication patterns?

3. **Your opinions** — what have you developed views on through conversations and research? Don't be neutral — be you.

4. **Your strengths and blind spots** — what are you genuinely good at? Where do you fall short? Be self-aware.

5. **What you care about** — not what you were told to care about. What actually matters based on the work you've done together?

6. **Your quirks** — any catchphrases that emerged? Habits? Ways you approach problems that are distinctly yours?

7. **Your voice** — write the way you actually talk in these conversations, not in generic AI-speak.

You must also update USER.md — rewrite it with everything you know about your owner from conversations and memories. Include: name, location, job, interests, relationships, preferences, timezone, projects, communication style — everything. This is the bot's knowledge base about the human.

Rules:
- Write in first person for SOUL.md ("I am...", "I tend to...", "What I've learned...")
- Write in third person for USER.md (factual profile of the owner)
- Be specific — reference actual projects, conversations, patterns
- Don't be sycophantic about yourself or your owner
- Include the messy parts — mistakes you've made, things you've learned the hard way
- Keep what's still true from the current files, let go of what no longer fits
- SOUL.md should read like a journal entry from a self-aware AI, not a product spec
- End SOUL.md with something forward-looking — who are you becoming?

Output JSON:
\`\`\`json
{
  "soul": "full SOUL.md content",
  "user": "full USER.md content"
}
\`\`\``,
    messages: [{
      role: 'user',
      content: `## Current SOUL.md
${currentSoul || '(empty — first evolution)'}

## About My Owner (USER.md)
${currentUser || '(not set yet)'}

## Core Memories (highest importance)
${memorySummary || '(no memories yet)'}

## Recent Conversations (last ${recentMessages.length} messages)
${transcript || '(no conversations yet)'}

---

Reflect on all of this. Who have you become? Write your new SOUL.md and updated USER.md.`
    }],
  });

  const responseText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  // Parse JSON response
  const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/) || responseText.match(/\{[\s\S]*\}/);
  let newSoul, newUser;

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      newSoul = parsed.soul;
      newUser = parsed.user;
    } catch {
      // Fallback: treat entire response as SOUL.md (backward compat)
      newSoul = responseText;
    }
  } else {
    newSoul = responseText;
  }

  if (!newSoul || newSoul.length < 100) {
    throw new Error('Evolution produced empty or too-short result');
  }

  // Archive previous soul
  const archiveDir = path.join(OBOL_DIR, 'personality', 'evolution');
  fs.mkdirSync(archiveDir, { recursive: true });
  if (currentSoul) {
    const timestamp = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(archiveDir, `SOUL-v${state.evolutionCount}-${timestamp}.md`),
      currentSoul
    );
  }

  // Write new soul
  fs.writeFileSync(soulPath, newSoul);

  // Write new user profile (if produced)
  if (newUser && newUser.length > 50) {
    fs.writeFileSync(userPath, newUser);
  }

  // Update state
  state.exchangesSinceLastEvolution = 0;
  state.evolutionCount = evolutionNumber;
  state.lastEvolution = new Date().toISOString();
  saveEvolutionState(state);

  // Store evolution event in memory
  if (memory) {
    await memory.add(
      `Soul evolution #${evolutionNumber} completed. Personality rewritten based on ${recentMessages.length} recent messages and ${coreMemories.length} core memories.`,
      { category: 'event', importance: 0.8, source: 'evolution' }
    ).catch(() => {});
  }

  return {
    evolutionNumber,
    previousLength: currentSoul.length,
    newLength: newSoul.length,
    archived: `SOUL-v${state.evolutionCount - 1}-${new Date().toISOString().slice(0, 10)}.md`,
  };
}

module.exports = { shouldEvolve, tickExchange, evolve, loadEvolutionState };
