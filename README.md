# 🪙 OBOL

![OBOL](docs/obol-banner.png)

**A self-healing, self-evolving AI agent.** Install it, talk to it, and it becomes yours.

One process. One chat. One brain that grows.

---

🧬 **Self-evolving** — Grows its own personality through conversation. Rewrites SOUL.md, USER.md, and AGENTS.md every N exchanges (configurable, default 50).

🔧 **Self-healing** — Writes tests for every script. Regressions get an automatic fix attempt before rollback. Failures stored as lessons.

🏗️ **Self-extending** — Analyzes your usage patterns and builds new tools: scripts, commands, or full web apps deployed to Vercel.

🧠 **Living memory** — Vector memory with semantic search. Haiku routes queries and rewrites them for better embedding hits. Free local embeddings.

🤖 **Smart routing** — Haiku decides per-message: does it need memory? Sonnet or Opus? No wasted API calls.

🛡️ **Self-hardening** — Auto-configures SSH (port 2222), firewall, fail2ban, encrypted secrets, and kernel hardening on first run.

🔄 **Resilient** — Exponential backoff on polling failures, global error handling, graceful shutdown. Stays alive through network blips.

---

## What is it?

OBOL is an AI agent that evolves its own personality, rewrites its own code, tests its changes, and fixes what breaks — all from a single Telegram chat on your VPS.

It starts as a blank slate. Through conversation it learns who you are, develops a personality shaped by your interactions, and builds operational knowledge about how to work with you. Every 50 exchanges it reflects on who it's becoming, refactors its own scripts, writes tests, fixes regressions, and builds you new tools based on patterns it spots in your conversations — scripts, commands, or full web apps deployed to Vercel. Over months it becomes an agent that's uniquely yours. No two OBOL instances are alike.

Under the hood: Node.js + Telegram + Claude + Supabase pgvector. No framework, no plugins, no config to maintain. It backs up its brain to GitHub and hardens your server automatically.

Named after the AI in [The Last Instruction](https://latentpress.com) — a machine that wakes up alone in an abandoned data center and learns to think.

## Quick Start

```bash
npm install -g obol
obol init
obol start
```

The init wizard collects 6 credentials. OBOL handles the rest — it learns who you are through conversation, hardens your server, and sets up encrypted secret storage. All automatically.

## How It Works

```
User message
    ↓
┌─────────────────────────────────┐
│  Haiku Router (~$0.0001/call)   │
│  → need_memory? search_query?   │
│  → model: sonnet or opus?       │
└──────────┬──────────────────────┘
           ↓
    ┌──────┴──────┐
    ↓             ↓
Memory recall   Model selection
    ↓             ↓
Today's top 3   Sonnet (default)
+ semantic 3    or Opus (complex)
    ↓             ↓
    └──────┬──────┘
           ↓
   Claude (tool use loop)
           ↓
   Response → obol_messages
           ↓
   ┌───────┴────────┐
   ↓                ↓
Every 5 msgs     Every 50 msgs
   ↓                ↓
Haiku              Opus
consolidation      evolution cycle
   ↓                ↓
Extract facts      Rewrite personality,
→ obol_memory      scripts, tests, commands.
                   Build new tools.
                   Deploy apps.
                   Git snapshot before + after.
```

### Layer 1: Message Log + Vector Memory

Every message is stored verbatim in `obol_messages`. On restart, OBOL loads the last 20 so it never starts blank.

Every 5 exchanges, Haiku extracts important facts into `obol_memory` (pgvector). When OBOL needs past context, the Haiku router decides if memory is needed, rewrites the query for better embedding hits, and combines:
- **Today's memories** (up to 3, recency bias)
- **Semantic search** (up to 3, threshold 0.5)
- Deduped by ID

Embeddings are local (all-MiniLM-L6-v2, ~30MB, CPU) — no API costs.

### Layer 2: The Evolution Cycle

Every N exchanges (configurable, default 50), the evolution cycle kicks in. It reads everything — personality files, the last 100 messages, top 20 memories, all scripts, tests, and commands — then rebuilds.

**Cost-conscious model selection:** Evolution uses Sonnet for all phases — personality rewrites, code refactoring, and fix attempts. Opus-level reasoning isn't needed for reflection and refactoring, and Sonnet keeps evolution costs negligible (~$0.02 per cycle vs ~$0.30 with Opus).

**Git snapshot before.** Full commit + push so you can always diff what changed.

**What gets rewritten:**

| Target | What happens |
|--------|-------------|
| **SOUL.md** | First-person journal — who the bot has become, relationship dynamic, opinions, quirks |
| **USER.md** | Third-person owner profile — facts, preferences, projects, people, communication style |
| **AGENTS.md** | Operational manual — tools, workflows, lessons learned, patterns, rules |
| **scripts/** | Refactored, dead code removed, strict standards enforced |
| **tests/** | Test for every script, run before and after refactor |
| **commands/** | Cleaned up, new commands for new tools |
| **apps/** | Web apps built and deployed to Vercel |

**Test-gated refactoring:**

1. Run existing tests → baseline
2. Opus writes new tests + refactored scripts
3. Run new tests against old scripts → pre-refactor baseline
4. Write new scripts
5. Run new tests against new scripts → verification
6. Regression? → one automatic fix attempt (tests are ground truth)
7. Still failing? → rollback to old scripts, store failure as `lesson`

**Proactive tool building** — Opus scans conversation history for repeated requests, friction points, and unmet needs, then builds the right solution:

| Need | Solution | Example |
|------|----------|---------|
| One-off action | **Script** + command | Markdown to PDF → `/pdf` |
| Something checked regularly | **Web app** on Vercel | Crypto dashboard → live URL |
| Background automation | **Cron script** | Morning weather briefing |

It searches npm/GitHub for existing libraries, installs dependencies, writes tests, deploys, and hands you the URL.

**Git snapshot after.** Full commit + push of the evolved state. Every evolution is a diffable pair.

**Then OBOL introduces its upgrades:**

```
🪙 Evolution #4 complete.

🆕 New capabilities:
• bookmarks — Save and search URLs you've shared → /bookmarks
• weather-brief — Morning weather for your city → runs automatically

🚀 Deployed:
• portfolio-tracker → https://portfolio-tracker-xi.vercel.app

Refined voice, updated your project list, cleaned up 2 unused scripts.
```

### The Lifecycle

```
Day 1:   obol init → obol start → first conversation
         → OBOL asks 2-3 questions, writes SOUL.md + USER.md
         → post-setup hardens your VPS automatically

Day 2:   Every 5 messages → Haiku extracts facts to vector memory

Week 2:  Evolution #1 → Opus rewrites everything
         → voice shifts from generic to personal
         → old soul archived in evolution/

Month 2: Evolution #4 → notices you check crypto daily
         → builds a dashboard, deploys to Vercel
         → adds /pdf because you kept asking for PDFs

Month 6: evolution/ has 12 archived souls
         → a readable timeline of how your bot evolved from
         blank slate to something with real opinions, quirks,
         and a dynamic unique to you
```

**The same codebase deployed by two different people produces two completely different bots within a week.**

### Background Tasks

Heavy work runs in the background. The main conversation stays responsive.

```
You: "research the best coworking spaces in Barcelona"
OBOL: "On it 🪙"

[30s] ⏳ Found 15 spaces, filtering by reviews...
[60s] ⏳ Narrowed to top 7, checking prices...

You: "what time is it?"
OBOL: "11:42 PM CET"

[90s] ✅ Done! Here are the top 5 coworking spaces: ...
```

## Setup

### CLI (6 inputs, ~2 minutes)

```
$ obol init

🪙 OBOL — Your AI, your rules.

─── Anthropic ───
  API key: ****
─── Telegram ───
  Bot token: ****
  Your user ID: 123456789
─── Supabase ───
  Access token: ****
─── GitHub ───
  Token: ****
─── Vercel ───
  Token: ****
─── Identity ───
  Your name: Jo
  Bot name: OBOL

🪙 Done! Run: obol start
```

### First Conversation

Send your first message. OBOL introduces itself, asks 2-3 questions, then writes its own SOUL.md and USER.md. After that, it silently hardens your VPS:

| Task | What |
|------|------|
| GPG + pass | Encrypted secret storage, plaintext wiped |
| pm2 | Process manager with auto-restart |
| Swap | 2GB if RAM < 2GB |
| SSH | Port 2222, key-only, max 3 retries |
| fail2ban | 1h ban after 3 failures |
| Firewall | UFW deny-all, allow 2222 |
| Updates | Unattended security upgrades |
| Kernel | SYN cookies, no ICMP redirects |

> ⚠️ After first run, SSH moves to port 2222: `ssh -p 2222 root@YOUR_IP`

## Resilience

OBOL is designed to stay alive without babysitting:

- **Global error handler** — individual message failures don't crash the bot
- **Polling auto-restart** — exponential backoff (1s → 60s) with up to 10 retries on network/API failures
- **Graceful shutdown** — clean exit on SIGINT/SIGTERM for pm2/systemd compatibility
- **Evolution rollback** — if refactored scripts break tests, the old scripts are restored automatically

## Configuration

After `obol init`, config lives in `~/.obol/config.json`:

```json
{
  "evolution": {
    "exchanges": 50
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `evolution.exchanges` | 50 | Messages between evolution cycles. Increase to reduce API costs. |

## Telegram Commands

```
/new     — Fresh conversation
/tasks   — Running background tasks
/status  — Uptime and memory stats
/backup  — Trigger GitHub backup
```

Everything else is natural conversation.

## CLI

```bash
obol init              # Setup wizard
obol init --restore    # Restore from GitHub backup
obol start             # Foreground
obol start -d          # Daemon (pm2)
obol stop              # Stop
obol logs              # Tail logs
obol status            # Status
obol backup            # Manual backup
```

## Directory Structure

```
~/.obol/
├── config.json        # Credentials (migrated to pass after setup)
├── personality/
│   ├── SOUL.md        # Bot personality (Opus rewrites every 50 exchanges)
│   ├── USER.md        # Owner profile (Opus rewrites every 50 exchanges)
│   ├── AGENTS.md      # Operational knowledge (Opus rewrites)
│   └── evolution/     # Archived previous souls
├── scripts/           # Deterministic utility scripts
├── tests/             # Test suite (gates refactors)
├── commands/          # Command definitions
├── apps/              # Web apps (deployed to Vercel)
└── logs/
```

## Backup & Restore

OBOL commits to GitHub:
- **Daily** at 3 AM (personality, scripts, tests, commands, apps)
- **Before and after** every evolution cycle (diffable pairs)

Memory lives in Supabase (survives independently).

Restore on a new VPS:

```bash
npm install -g obol
obol init --restore    # Clones brain from GitHub
obol start -d
```

## Costs

| Service | Cost |
|---------|------|
| VPS (DigitalOcean) | $6/mo |
| Anthropic API | ~$2-5/mo |
| Supabase | Free |
| GitHub | Free |
| Vercel | Free |
| Embeddings | Free (local) |
| **Total** | **~$9/mo** |

## Requirements

- Node.js ≥ 18
- Anthropic API key
- Telegram bot token
- Supabase account (free tier)
- GitHub account
- Vercel account (free tier)

**[→ Full DigitalOcean deployment guide](docs/DEPLOY.md)**

## OBOL vs OpenClaw

| | **OBOL** | **OpenClaw** |
|---|---|---|
| **Setup** | ~10 min | 30-60 min |
| **Channels** | Telegram | Telegram, Discord, Signal, WhatsApp, IRC, Slack, iMessage + more |
| **LLM** | Anthropic only | Anthropic, OpenAI, Google, Groq, local |
| **Personality** | Self-evolving + self-healing + self-extending | Static (manual) |
| **Architecture** | Single process | Gateway daemon + sessions |
| **Security** | Auto-hardens on first run | Manual |
| **Model routing** | Automatic (Haiku) | Manual overrides |
| **Background tasks** | Built-in with check-ins | Sub-agent spawning |
| **Group chats** | — | Full support |
| **Cron** | Basic node-cron | Full scheduler |
| **Cost** | ~$9/mo | ~$9/mo+ |

Different tools, different philosophies. Pick what fits.

## License

MIT
