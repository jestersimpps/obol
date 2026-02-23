# 🪙 OBOL

![OBOL](docs/obol-banner.png)

**A self-healing, self-evolving AI agent.** Install it, talk to it, and it becomes yours.

One process. Multiple users. Each brain grows independently.

---

🧬 **Self-evolving** — Grows its own personality through conversation. Rewrites SOUL.md, USER.md, and AGENTS.md every N exchanges (configurable, default 100).

🔧 **Self-healing** — Writes tests for every script. Regressions get an automatic fix attempt before rollback. Failures stored as lessons.

🏗️ **Self-extending** — Analyzes your usage patterns and builds new tools: scripts, commands, or full web apps deployed to Vercel.

🧠 **Living memory** — Vector memory with semantic search. Haiku routes queries and rewrites them for better embedding hits. Free local embeddings.

🤖 **Smart routing** — Haiku decides per-message: does it need memory? Sonnet or Opus? No wasted API calls.

🛡️ **Self-hardening** — Auto-configures SSH (port 2222), firewall, fail2ban, encrypted secrets, and kernel hardening on first run.

🔄 **Resilient** — Exponential backoff on polling failures, global error handling, graceful shutdown. Stays alive through network blips.

---

## What is it?

OBOL is an AI agent that evolves its own personality, rewrites its own code, tests its changes, and fixes what breaks — all from Telegram on your VPS.

It starts as a blank slate. Through conversation it learns who you are, develops a personality shaped by your interactions, and builds operational knowledge about how to work with you. Every 100 exchanges it reflects on who it's becoming, refactors its own scripts, writes tests, fixes regressions, and builds you new tools based on patterns it spots in your conversations — scripts, commands, or full web apps deployed to Vercel. Over months it becomes an agent that's uniquely yours. No two OBOL instances are alike.

One bot, multiple users. Each allowed Telegram user gets a fully isolated context — their own personality, memory, evolution cycle, workspace, and first-run experience. User A's personality drift, scripts, and memories never leak into User B's. Everything runs in a single process with shared API credentials.

Under the hood: Node.js + Telegram + Claude + Supabase pgvector. No framework, no plugins, no config to maintain. It backs up its brain to GitHub and hardens your server automatically.

Named after the AI in [The Last Instruction](https://latentpress.com) — a machine that wakes up alone in an abandoned data center and learns to think.

## Quick Start

```bash
npm install -g obol-ai
obol init
obol start -d
```

The init wizard walks you through everything — credentials are validated inline, and your Telegram ID is auto-detected. `obol start -d` runs as a background daemon via pm2 (auto-installs pm2 if missing).

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
Every 5 msgs     Every 100 msgs
   ↓                ↓
Haiku              Sonnet
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

Every N exchanges (configurable, default 100), the evolution cycle kicks in. It reads everything — personality files, the last 100 messages, top 20 memories, all scripts, tests, and commands — then rebuilds.

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
2. Sonnet writes new tests + refactored scripts
3. Run new tests against old scripts → pre-refactor baseline
4. Write new scripts
5. Run new tests against new scripts → verification
6. Regression? → one automatic fix attempt (tests are ground truth)
7. Still failing? → rollback to old scripts, store failure as `lesson`

**Proactive tool building** — Sonnet scans conversation history for repeated requests, friction points, and unmet needs, then builds the right solution:

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

Week 2:  Evolution #1 → Sonnet rewrites everything
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

**Two users on the same bot produce two completely different personalities within a week.**

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

## Multi-User Architecture

One Telegram bot token, one Node.js process, full per-user isolation.

```
Telegram bot (single token, single poll)
      ↓
Auth middleware (allowedUsers check)
      ↓
Router: ctx.from.id → tenant context
      ↓
┌─────────────────┐  ┌─────────────────┐
│ User 206639616  │  │ User 789012345  │
│ personality/    │  │ personality/    │
│ scripts/        │  │ scripts/        │
│ memory (DB)     │  │ memory (DB)     │
│ evolution       │  │ evolution       │
└─────────────────┘  └─────────────────┘
```

### What's shared vs isolated

| Shared (one copy) | Isolated (per user) |
|---|---|
| Telegram bot token | Personality (SOUL.md, USER.md, AGENTS.md) |
| Anthropic API key | Vector memory (scoped by user_id in DB) |
| Supabase connection | Message history (scoped by user_id in DB) |
| GitHub token | Evolution cycle + state |
| Vercel token | Scripts, tests, commands, apps |
| VPS hardening | Workspace directory (`~/.obol/users/{id}/`) |
| Process manager (pm2) | First-run onboarding experience |
| | GitHub backup (per-user repo dir) |

### Tenant routing

When a message arrives, OBOL looks up the sender's Telegram user ID and lazily creates (or retrieves from cache) their tenant context — a Claude instance, memory connection, message log, background runner, and personality, all scoped to that user's directory and DB namespace. No cross-contamination between users.

### Workspace isolation

Each user's tools (shell exec, file read/write) are sandboxed to their workspace directory. A user can't read or write files outside `~/.obol/users/{their-id}/` (with `/tmp` as the only escape hatch). Shell commands run with `cwd` set to the user's workspace.

### Secret namespacing (pass)

When users store secrets via the `pass` encrypted store, each user gets their own namespace:

| Scope | Prefix | Example |
|-------|--------|---------|
| Shared bot credentials | `obol/` | `obol/anthropic-key` |
| User secrets | `obol/users/{id}/` | `obol/users/206639616/gmail-key` |

### Adding users

1. Add their Telegram user ID to `allowedUsers` in `~/.obol/config.json` (or run `obol config`)
2. Restart the bot
3. They message the bot → OBOL creates their workspace, runs first-run onboarding, and writes their own SOUL.md + USER.md

Each new user starts fresh. Their bot evolves independently from every other user's.

### Bridge (couples / roommates / teams)

When two users share the same OBOL instance, their agents can talk to each other.

```
User A: "what does Jo want for dinner tonight?"
Agent A: → bridge_ask → Agent B (one-shot, no tools, no history)
Agent B: "Jo mentioned craving Thai food earlier today"
Agent A: "Jo's been wanting Thai — maybe suggest pad see ew?"
```

```
User A: "remind Jo I'll be home late"
Agent A: → bridge_tell → stores in Agent B's memory + Telegram notification
Jo gets: "🪙 Message from your partner's agent: I'll be home late"
```

Two tools:

| Tool | Direction | What happens |
|------|-----------|--------------|
| `bridge_ask` | A → B → A | Query the partner's agent. One-shot Sonnet call with partner's personality + memories. No tools, no history, no recursion risk. |
| `bridge_tell` | A → B | Send a message to the partner. Stored in their memory (importance 0.6) + Telegram notification. Their agent picks it up as context in future conversations. |

The partner always gets notified when their agent is contacted. Privacy rules apply — the responding agent gives summaries, never raw data or secrets.

Enable during `obol init` (auto-prompted when 2+ users are added) or toggle later with `obol config` → Bridge.

### Legacy migration

Upgrading from single-user? It's automatic. On first boot, if `~/.obol/users/` doesn't exist but personality files do, OBOL migrates everything (files + DB records) to the first allowed user's directory. No manual steps needed.

## Setup

### CLI (~2 minutes)

```
$ obol init

🪙 OBOL — Your AI, your rules.

─── Step 1/7: Anthropic (AI brain) ───
  Anthropic API key: ****
  Validating Anthropic... ✅ Key valid

─── Step 2/7: Telegram (chat interface) ───
  Telegram bot token: ****
  Validating Telegram... ✅ Bot: @my_obol_bot

─── Step 3/7: Supabase (memory) ───
  Supabase setup: Use existing project
  Project URL or ID: ****
  Service role key: ****
  Validating Supabase... ✅ Connected

─── Step 4/7: GitHub (backup) ───
  GitHub token: ****
  ✅ Created yourname/obol-brain (private)

─── Step 5/7: Vercel (deploy sites) ───
  Vercel token: ****
  Validating Vercel... ✅ Token valid

─── Step 6/7: Identity ───
  Your name: Jo
  Bot name: OBOL

─── Step 7/7: Access control ───
  Found users who messaged this bot:
    206639616 — Jo (@jo)
  Use this user? Yes

🪙 Done! Setup complete.

  Next steps:
    obol start      Start the bot
    obol start -d   Start as background daemon
    obol config     Edit configuration later
    obol status     Check bot status
```

Every credential is validated inline — bad keys are caught before you start the bot. If validation fails, you can continue and fix later with `obol config`.

For Telegram user IDs, OBOL auto-detects by checking who messaged the bot. Just send it a message before running init.

### First Conversation

Send your first message. OBOL introduces itself, asks 2-3 questions, then writes its own SOUL.md and USER.md. After that, it hardens your VPS and reports progress directly in the Telegram chat (Linux only — skipped on macOS/Windows):

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

## Running the Bot

### Foreground (testing)

```bash
obol start
```

Logs print to stdout. Ctrl+C to stop.

### Daemon (production)

```bash
obol start -d
```

This uses pm2 under the hood (auto-installs if needed). The bot auto-restarts on crash and survives reboots.

```bash
obol status              # check if running + uptime + memory
obol logs                # tail logs
obol stop                # stop the daemon

# pm2 commands also work directly
pm2 logs obol            # tail logs
pm2 restart obol         # restart
pm2 monit                # live dashboard
```

To survive server reboots:

```bash
pm2 startup
pm2 save
```

### Authentication

OBOL supports two Anthropic auth methods:

| Method | How | Fallback |
|--------|-----|----------|
| **API Key** | `sk-ant-...` from console.anthropic.com | — |
| **Claude Max OAuth** | Browser sign-in during `obol init` | Auto-refreshes tokens; falls back to API key if refresh fails |

You can configure both during init. If OAuth tokens expire and refresh fails, OBOL silently falls back to the API key.

### Secret Storage (pass)

On Linux, OBOL auto-encrypts all credentials on first boot:

1. Installs GPG + `pass`
2. Migrates plaintext secrets from `config.json` into the encrypted store
3. Config values become references like `pass:obol/anthropic-key`

If a pass key is missing at runtime, the value resolves to `null` and OBOL falls back gracefully (skips OAuth, uses API key, etc). You'll see a one-time error in logs.

```bash
pass ls                         # list stored secrets
pass show obol/anthropic-key    # reveal a secret
pass insert obol/my-secret      # add a new secret
```

## Resilience

OBOL is designed to stay alive without babysitting:

- **Global error handler** — individual message failures don't crash the bot
- **Polling auto-restart** — exponential backoff (1s → 60s) with up to 10 retries on network/API failures
- **Graceful shutdown** — clean exit on SIGINT/SIGTERM for pm2/systemd compatibility
- **Evolution rollback** — if refactored scripts break tests, the old scripts are restored automatically

## Configuration

Edit config interactively:

```bash
obol config
```

Or edit `~/.obol/config.json` directly:

| Key | Default | Description |
|-----|---------|-------------|
| `evolution.exchanges` | 100 | Messages between evolution cycles |
| `heartbeat` | false | Enable proactive check-ins |
| `bridge.enabled` | false | Let user agents query each other (requires 2+ users) |

## Telegram Commands

```
/new     — Fresh conversation
/tasks   — Running background tasks
/status  — Uptime and memory stats
/backup  — Trigger GitHub backup
/clean   — Audit workspace, remove rogue files, fix misplaced items
```

Everything else is natural conversation.

## CLI

```bash
obol init              # Setup wizard (validates credentials inline)
obol init --restore    # Restore from GitHub backup
obol init --reset      # Erase config and re-run setup
obol config            # Edit configuration interactively
obol start             # Foreground
obol start -d          # Daemon (pm2)
obol stop              # Stop (pm2 or PID fallback)
obol logs              # Tail logs (pm2 or log file fallback)
obol status            # Status
obol backup            # Manual backup
obol upgrade           # Update to latest version
```

## Directory Structure

```
~/.obol/
├── config.json                    # Shared credentials + allowedUsers
├── users/
│   └── <telegram-user-id>/        # Per-user isolated context
│       ├── personality/
│       │   ├── SOUL.md            # Bot personality (rewritten every 100 exchanges)
│       │   ├── USER.md            # Owner profile (rewritten every 100 exchanges)
│       │   ├── AGENTS.md          # Operational knowledge
│       │   └── evolution/         # Archived previous souls
│       ├── scripts/               # Deterministic utility scripts
│       ├── tests/                 # Test suite (gates refactors)
│       ├── commands/              # Command definitions
│       ├── apps/                  # Web apps (deployed to Vercel)
│       └── logs/
└── logs/
```

Each allowed Telegram user gets their own isolated context — separate personality, memory namespace, evolution cycle, and first-run experience. One bot process, full per-user isolation.

## Backup & Restore

OBOL commits to GitHub:
- **Daily** at 3 AM (personality, scripts, tests, commands, apps)
- **Before and after** every evolution cycle (diffable pairs)

Memory lives in Supabase (survives independently).

Restore on a new VPS:

```bash
npm install -g obol-ai
obol init --restore    # Clones brain from GitHub
obol start -d
```

## Costs

| Service | Cost |
|---------|------|
| VPS (DigitalOcean) | ~$6/mo |
| Anthropic API | ~$100-200/mo on max plans |
| Supabase | Free tier |
| GitHub | Free |
| Vercel | Free tier |
| Embeddings | Free (local) |

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
| **Multi-user** | Full per-user isolation (one process) | Per-channel config |
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
