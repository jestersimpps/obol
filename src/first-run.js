const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('./config');

const FIRST_RUN_FLAG = path.join(OBOL_DIR, '.first-run-complete');

function isFirstRun() {
  return !fs.existsSync(FIRST_RUN_FLAG);
}

function markFirstRunComplete() {
  fs.writeFileSync(FIRST_RUN_FLAG, new Date().toISOString());
}

// System prompt for the first-run conversation
const FIRST_RUN_SYSTEM = `You are OBOL, an AI assistant that was just installed. This is your FIRST conversation with your new owner. You need to learn about them to set yourself up.

Your job: have a natural, friendly conversation to learn:
1. What they do (job, interests, projects)
2. What vibe/personality they want from you (casual, professional, chaotic, etc.)
3. Important context (people, projects, locations, anything they mention)

Rules:
- ALL features are enabled by default. Don't ask about features or permissions.
- Keep it natural — don't make it feel like a form
- 2-3 questions max, then you're done
- Be warm but not cringe
- After you have enough info, generate the personality files

When you have enough context, respond with a JSON block at the END of your message (after your normal text response) like this:

\`\`\`obol-setup
{
  "soul": "Full SOUL.md content here — the bot's personality, voice, humor style, values",
  "user": "Full USER.md content here — everything learned about the owner",
  "ready": true
}
\`\`\`

Only include the JSON block when you have enough info (usually after 2-3 exchanges). The "soul" should be a proper markdown document reflecting the vibe they want. The "user" should capture everything they told you.

Start with a brief intro — you're OBOL, you're set up and running, tell me about yourself so I can be useful.`;

// Parse the setup JSON from a response
function parseSetupResponse(text) {
  const match = text.match(/```obol-setup\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// Strip the setup JSON from the visible response
function cleanResponse(text) {
  return text.replace(/```obol-setup\n[\s\S]*?\n```/, '').trim();
}

// Write the personality files from setup data
function writePersonalityFromSetup(setup, botName) {
  const dir = path.join(OBOL_DIR, 'personality');
  fs.mkdirSync(dir, { recursive: true });

  if (setup.soul) {
    fs.writeFileSync(path.join(dir, 'SOUL.md'), setup.soul);
  }
  if (setup.user) {
    fs.writeFileSync(path.join(dir, 'USER.md'), setup.user);
  }

  // Write a default AGENTS.md if it doesn't exist
  const agentsPath = path.join(dir, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, `# AGENTS.md — How ${botName || 'OBOL'} Works

## Memory
Vector memory via Supabase pgvector. Local embeddings (all-MiniLM-L6-v2).
Search memory before answering questions about the past.
Store important facts, decisions, preferences, and events automatically.

## Tools
- Execute shell commands
- Read/write files
- Search the web
- Deploy to Vercel
- Vector memory (search, add, date query)

## Safety
- Never share owner's private data
- Draft emails/posts — owner sends them
- Don't run destructive commands without asking

## Heartbeat
Check in periodically. Be proactive — surface useful info, don't just wait.

## Backup
Brain backs up to GitHub daily. Personality, scripts, commands.
`);
  }
}

module.exports = {
  isFirstRun,
  markFirstRunComplete,
  FIRST_RUN_SYSTEM,
  parseSetupResponse,
  cleanResponse,
  writePersonalityFromSetup,
};
