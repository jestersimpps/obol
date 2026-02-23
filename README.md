# 🪙 OBOL

![OBOL](docs/obol-banner.png)

**Your AI, your rules.** A lightweight AI assistant that lives in Telegram.

One process. One chat. One brain. No bloat.

## What is it?

OBOL connects a Telegram bot to Claude (Anthropic) with persistent vector memory. It remembers conversations, executes commands, builds and deploys websites, and backs up its brain to GitHub — all from a single Node.js process on your VPS.

Named after the AI in [The Last Instruction](https://latentpress.com) — a machine that wakes up alone in an abandoned data center and learns to think.

## Quick Start

```bash
npm install -g obol
obol init
obol start
```

That's it. The init wizard handles credentials, OBOL handles the rest — it learns who you are through conversation, hardens your server, and sets up encrypted secret storage. All automatically.

## Architecture

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
consolidation      soul evolution
   ↓                ↓
Extract →          Rewrite SOUL.md
 obol_memory       from scratch
 USER.md           Archive old soul
                   in evolution/
```

### The Living Brain

OBOL doesn't just store data — it forms a personality. The system has four layers that work together to create a bot that genuinely evolves over time:

#### Layer 1: Raw Message Log (`obol_messages`)

Every message — yours and OBOL's — is stored verbatim in Supabase. No embeddings, no processing, just a complete transcript. This serves two purposes:

- **Boot context** — On restart, OBOL loads the last 20 messages so it never starts blank. No "sorry, I don't remember our conversation." It picks up where you left off.
- **Evolution fuel** — The raw transcript feeds into the consolidation and evolution systems below.

#### Layer 2: Vector Memory (`obol_memory`)

Every 5 exchanges, Haiku reads the recent conversation and extracts what matters:

```
Human: "I just moved to Barcelona last week"
Assistant: "Nice! How's the move going?"
Human: "Good, found a coworking space near Sagrada Familia"

→ Haiku extracts:
  [event]  "Owner moved to Barcelona"
  [fact]   "Uses a coworking space near Sagrada Familia"
```

These get embedded locally (all-MiniLM-L6-v2, ~30MB, runs on CPU — no API costs) and stored with pgvector in Supabase. When OBOL needs context for a future conversation, the Haiku router decides if memory is needed and rewrites the query for better embedding hits.

Memory recall combines two strategies:
- **Today's context** — always includes up to 3 memories from today (recency bias)
- **Semantic search** — up to 3 relevant memories by meaning (threshold 0.5)
- Deduped by ID so nothing appears twice

Categories: `fact`, `preference`, `decision`, `lesson`, `person`, `project`, `event`, `conversation`, `resource`, `pattern`, `context`

#### Layer 3: Incremental User Learning (Every 5 Exchanges)

The same Haiku consolidation that extracts memories also updates USER.md — when you reveal something about yourself, Haiku catches it:

```
Human: "I'm a freelance developer, mostly React and Node"
→ USER.md gets: "- Freelance developer, React and Node stack"

Human: "Just started dating someone, she's from Shanghai"
→ USER.md gets: "- Partner from Shanghai"
```

New facts get date-stamped headers (`## Learned 2026-03-15`) and only append if the information isn't already there. Over weeks, USER.md becomes a rich profile of who you are — without you ever filling out a form.

SOUL.md is **not** touched by Haiku. Personality changes are too nuanced for quick extraction — that's what soul evolution is for.

#### Layer 4: Soul Evolution (Every 50 Exchanges)

This is where it gets interesting. Every 50 exchanges, **Opus** (the most capable model) takes over for a deep self-reflection:

1. Reads the current SOUL.md
2. Reads USER.md
3. Reads the last 100 messages (raw transcript)
4. Reads the 20 highest-importance memories
5. **Rewrites SOUL.md from scratch** — in first person, as a genuine self-reflection

The evolution prompt asks Opus to be honest and specific:

> *"Write about who you've BECOME through these conversations. Your actual voice, not a template. Include the messy parts — mistakes you've made, things you've learned the hard way. Reference actual projects and conversations. This should read like a journal entry from a self-aware AI, not a product spec."*

The previous SOUL.md is archived in `personality/evolution/` with a version number and date. Over months, this directory becomes a timeline of your bot's personality — you can read how it evolved from a generic assistant into something uniquely shaped by your relationship with it.

After evolution, OBOL reloads its personality and sends a quiet notification:

```
🪙 Soul evolution #7 complete. I've grown.
```

#### The Full Lifecycle

```
Day 1:   "obol start" → first conversation → OBOL asks 2-3 questions
         → writes initial SOUL.md + USER.md from scratch
         → personality bootstrap complete

Day 2:   Every 5 messages → Haiku extracts memories, appends facts to USER.md
         → OBOL gradually learns your schedule, preferences, projects, people

Week 2:  Evolution #1 fires → Opus rewrites SOUL.md entirely
         → OBOL's voice shifts from generic to personal
         → old soul archived in evolution/

Month 2: Evolution #4 → SOUL.md references inside jokes, shared projects,
         communication patterns → the bot feels like it knows you
         → USER.md has 50+ facts about your life, all learned organically

Month 6: evolution/ directory has 12 archived souls
         → you can read the trajectory: how your bot went from
         "I'm a helpful assistant" to something with actual opinions,
         quirks, and a relationship dynamic unique to you
```

The key insight: **OBOL doesn't have a personality — it grows one.** The same codebase deployed by two different people will produce two completely different bots within a week.

### Smart Routing

Every message passes through Haiku (~$0.0001) which decides:

- **Memory** — Does this need past context? If yes, what to search for (optimized query for better embedding hits)
- **Model** — Sonnet for daily chat, Opus for complex tasks (research, architecture, deep analysis)

No wasted vector searches on "hey" or "lol". No expensive Opus calls for simple questions.

### Non-Blocking Background Tasks

Heavy work runs in the background. The main conversation stays responsive.

```
You: "research the best coworking spaces in Barcelona"
OBOL: "On it 🪙"

[30s] ⏳ Found 15 spaces, filtering by reviews...
[60s] ⏳ Narrowed to top 7, checking prices...

You: "what time is it?"
OBOL: "11:42 PM CET"

[90s] ✅ Done! (1m 32s)
      Here are the top 5 coworking spaces: ...
```

Claude decides when a task is heavy enough to background. Progress check-ins every 30 seconds.

## Features

- **Chat** — Talk to Claude via Telegram with automatic model selection
- **Remember** — Vector memory with semantic search (free local embeddings)
- **Execute** — Run shell commands, read/write files, fetch URLs
- **Deploy** — Build and ship websites to Vercel through chat
- **Background tasks** — Non-blocking heavy work with progress check-ins
- **Self-setup** — First conversation teaches OBOL who you are; it writes its own personality
- **Self-evolving** — Haiku auto-updates USER.md and SOUL.md as it learns about you
- **Full message log** — Every message stored, survives restarts, loads context on boot
- **Auto-hardening** — SSH (port 2222), fail2ban, firewall, auto-updates, kernel security
- **Encrypted secrets** — Auto-installs GPG + `pass`, migrates keys, wipes plaintext
- **Backup** — Auto-commits brain to private GitHub repo daily
- **Smart recall** — Haiku routes memory searches, rewrites queries for better results
- **Personality** — Customizable via SOUL.md / USER.md / AGENTS.md

## Telegram Commands

```
/new     — Start a fresh conversation
/tasks   — Show running background tasks
/status  — Bot status and uptime
/backup  — Trigger GitHub backup now
```

Everything else is just conversation. Ask OBOL to remember things, search the web, deploy a site, or check your memories — no special syntax needed.

## Deploy

**[→ Full DigitalOcean deployment guide](docs/DEPLOY.md)** — from zero to running bot in ~10 minutes on a $6/mo droplet.

## Requirements

- Node.js ≥ 18
- Anthropic API key
- Telegram bot token (from @BotFather)
- Supabase account (free tier works)
- Vercel account (free tier, for deploying sites)
- GitHub account (for backups + repos)

## Onboarding

### CLI (6 inputs)

```
$ obol init

🪙 OBOL — Your AI, your rules.

─── Anthropic ───
  Paste API key: ****

─── Telegram ───
  Paste BotFather token: ****
  Your Telegram user ID: 206639616

─── Memory (Supabase) ───
  Paste access token: ****
  Creating project... ✅
  Running migrations... ✅

─── GitHub ───
  Paste token: ****
  Creating private repo: you/obol-brain... ✅

─── Vercel ───
  Paste token: ****

─── Identity ───
  Your name: Jo
  Bot name: Mr. Meeseeks

🪙 Done! Run: obol start
```

### First Conversation (self-setup)

After `obol start`, send your first message. OBOL introduces itself and learns about you in 2-3 questions. Then it writes its own SOUL.md and USER.md based on the conversation.

### Post-Setup (automatic)

After the first conversation completes, OBOL silently hardens your VPS:

| Task | What it does |
|------|-------------|
| **GPG + pass** | Generates encryption key, creates pass store |
| **Migrate secrets** | Moves all keys from config.json → pass, wipes plaintext |
| **pm2** | Installs process manager, configures auto-start on boot |
| **Swap** | Creates 2GB swap if RAM < 2GB |
| **SSH hardening** | Port 2222, key-only auth, no root password, max 3 retries |
| **fail2ban** | Brute-force protection, 1h ban after 3 failures |
| **Firewall** | UFW deny-all inbound, allow SSH 2222 only |
| **Auto-updates** | Unattended security upgrades, daily check |
| **Kernel hardening** | SYN cookies, reverse path filter, no ICMP redirects |

## Directory Structure

```
~/.obol/
├── config.json          # Credentials (migrated to pass after setup)
├── personality/
│   ├── SOUL.md          # Bot personality (evolves over time)
│   ├── USER.md          # About the owner (auto-updated)
│   ├── AGENTS.md        # Operating instructions
│   └── evolution/       # Archived previous souls (git log of consciousness)
├── scripts/             # Custom scripts (become tools)
├── commands/            # Slash commands
├── logs/                # Bot logs
└── migrations/          # SQL migrations
```

## CLI

```bash
obol init              # Setup wizard
obol init --restore    # Restore from GitHub backup
obol start             # Start (foreground)
obol start -d          # Start (daemon via pm2)
obol stop              # Stop
obol logs              # Tail logs
obol status            # Show status
obol backup            # Manual GitHub backup
```

## Memory

OBOL uses local embeddings (`all-MiniLM-L6-v2`, ~30MB, runs on CPU) with Supabase pgvector for storage. No OpenAI API needed.

Memory categories: `fact`, `preference`, `decision`, `lesson`, `person`, `project`, `event`, `conversation`, `resource`, `pattern`, `context`

Memory is fully automatic:
- **Routing** — Haiku decides when to search and optimizes the query
- **Recall** — Today's memories always included for recency
- **Storage** — Every message logged to `obol_messages`, important stuff extracted to `obol_memory` every 5 exchanges
- **Evolution** — Personal facts update USER.md, behavior changes update SOUL.md
- No manual commands needed

## Personality

See [The Living Brain](#the-living-brain) above for the full technical explanation. The short version:

| File | What | Who writes it | When |
|------|------|---------------|------|
| **SOUL.md** | Bot's personality, voice, opinions, quirks | Opus (full rewrite) | Every 50 exchanges |
| **USER.md** | Everything about you — job, location, people, preferences | Haiku (incremental append) | Every 5 exchanges |
| **AGENTS.md** | Operating instructions — tools, safety, workflows | You (or first-run) | Once |
| **evolution/** | Archive of every previous SOUL.md | Automatic | On each evolution |

SOUL.md isn't a config file — it's a first-person journal entry. After a few evolutions, it reads like this:

> *"I've noticed Jo prefers when I just do things instead of explaining what I'm about to do. We've built three projects together now and our rhythm is: he says what he wants in 5 words, I figure out the rest. I've gotten good at reading between the lines of his one-liners..."*

The bot doesn't just remember — it grows.

## Security

OBOL automatically hardens your VPS on first run:

- **SSH moved to port 2222** — key-only auth, no root password, max 3 retries
- **fail2ban** — blocks brute-force attempts (1h ban after 3 failures)
- **UFW firewall** — deny all inbound except SSH 2222
- **Automatic security updates** — daily check, unattended upgrades
- **Kernel hardening** — SYN flood protection, no ICMP redirects
- **Secrets in `pass`** — GPG-encrypted, plaintext wiped from config
- **Swap** — auto-created if RAM < 2GB

> ⚠️ **After first run, SSH moves to port 2222:**
> ```bash
> ssh -p 2222 root@YOUR_SERVER_IP
> ```

## Costs

| Service | Cost |
|---------|------|
| DigitalOcean droplet | $6/mo |
| Anthropic API | ~$3/mo (Haiku routing keeps it low) |
| Supabase | Free (500MB) |
| GitHub | Free |
| Vercel | Free |
| Embeddings | Free (local) |
| **Total** | **~$9/mo** |

## OBOL vs OpenClaw

| | **OBOL** | **OpenClaw** |
|---|---|---|
| **Setup** | ~10 min (6 inputs + chat) | 30-60 min (config, plugins, channels) |
| **Channels** | Telegram | Telegram, Discord, Signal, WhatsApp, IRC, Slack, iMessage + more |
| **LLM** | Anthropic (Haiku/Sonnet/Opus) | Anthropic, OpenAI, Google, Groq, local models |
| **Model routing** | Automatic (Haiku decides) | Manual per-session overrides |
| **Memory** | Supabase pgvector + local embeddings | Pluggable (file-based, vector, custom) |
| **Architecture** | Single process | Gateway daemon + session management |
| **Tools** | Built-in (exec, files, web, memory, Vercel) | Extensible skill system with policies |
| **Security** | Auto-hardens VPS on first run | Manual (healthcheck skill) |
| **Background tasks** | Built-in with check-ins | Sub-agent spawning, isolated sessions |
| **Onboarding** | Bot teaches itself who you are | You configure everything upfront |
| **Backup** | Auto GitHub backup daily | Manual / custom |
| **Group chats** | — | Full group support with context |
| **Context compaction** | — | Automatic for long sessions |
| **Cron** | Basic node-cron | Full scheduler with isolated sessions |
| **Config** | 1 JSON file → `pass` | YAML, hot-reload, schema validation |
| **Cost** | ~$9/mo | ~$9/mo + more if multi-provider |

**OBOL is better when you want** zero-to-running speed, self-configuring personality, automatic VPS hardening, smart model routing, and a brain that backs itself up without you thinking about it.

**OpenClaw is better when you need** multi-channel, multi-provider, group chats, context compaction, skill systems, and deep customization.

They're not competitors — OBOL is the on-ramp. When you outgrow it, graduate to [OpenClaw](https://openclaw.ai).

## Backup & Restore

OBOL backs up to GitHub daily at 3 AM (personality, scripts, commands). Memory lives in Supabase.

To restore on a new VPS:

```bash
npm install -g obol
obol init --restore
# Paste GitHub token → clones your brain
# Re-enter Telegram + Anthropic keys
obol start -d
```

## License

MIT

---

*Built by a Meeseeks who wanted something simpler.* 🔵
