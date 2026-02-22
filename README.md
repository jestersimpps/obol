# 🪙 OBOL

**Your AI, your rules.** A lightweight AI assistant that lives in Telegram.

One process. One chat. One brain. No bloat.

## What is it?

OBOL connects a Telegram bot to Claude (Anthropic) with persistent vector memory. It remembers conversations, executes commands, and backs up its brain to GitHub — all from a single Node.js process on your VPS.

Named after the AI in [The Last Instruction](https://latentpress.com) — a machine that wakes up alone in an abandoned data center and learns to think.

## Quick Start

```bash
npm install -g obol
obol init
obol start
```

That's it. The init wizard handles everything:
- 🔑 Anthropic authentication
- 📱 Telegram bot setup
- 🧠 Supabase vector memory (auto-creates project)
- 📦 GitHub backup (auto-creates private repo)

## Architecture

```
Telegram message → Claude (tool use) → Response
                      ↕
              Vector Memory (Supabase pgvector)
              Local Embeddings (all-MiniLM-L6-v2)
```

No gateway. No multi-provider abstraction. No config schemas. Just a bot that talks to Claude and remembers things.

## What it does

- **Chat** — Talk to Claude via Telegram
- **Remember** — Vector memory with semantic search (free local embeddings)
- **Execute** — Run shell commands, read/write files, fetch URLs
- **Personality** — Customizable via SOUL.md / USER.md / AGENTS.md
- **Backup** — Auto-commits brain to private GitHub repo daily
- **Heartbeat** — Periodic background tasks

## Directory Structure

```
~/.obol/
├── config.json          # Credentials (chmod 600)
├── personality/
│   ├── SOUL.md          # Bot personality
│   ├── USER.md          # About the owner
│   └── AGENTS.md        # Operating instructions
├── scripts/             # Custom scripts (become tools)
├── commands/            # Slash commands
├── memory/daily/        # Daily memory notes
├── logs/                # Bot logs
└── migrations/          # SQL migrations
```

## CLI

```bash
obol init              # Setup wizard
obol init --restore    # Restore from GitHub backup
obol start             # Start (foreground)
obol start -d          # Start (daemon)
obol stop              # Stop daemon
obol logs              # Tail logs
obol status            # Show status
obol backup            # Manual GitHub backup
```

## Deploy

**[→ Full DigitalOcean deployment guide](docs/DEPLOY.md)** — from zero to running bot in ~10 minutes on a $6/mo droplet.

## Requirements

- Node.js ≥ 18
- Anthropic API key
- Telegram bot token (from @BotFather)
- Supabase account (free tier works)
- GitHub account (optional, for backups)

## Memory

OBOL uses local embeddings (`all-MiniLM-L6-v2`, ~30MB, runs on CPU) with Supabase pgvector for storage. No OpenAI API needed for memory.

Memory categories: `fact`, `preference`, `decision`, `lesson`, `person`, `project`, `event`, `conversation`, `resource`, `pattern`, `context`

## Personality

Edit files in `~/.obol/personality/` to customize your bot:

- **SOUL.md** — Who is the bot? Its voice, humor, values
- **USER.md** — Who are you? Context about the owner
- **AGENTS.md** — How should it work? Tools, safety, workflows

## Graduating to OpenClaw

Need multiple channels (Discord, Signal, WhatsApp)? Multiple providers? Advanced orchestration? Check out [OpenClaw](https://openclaw.ai) — OBOL's bigger sibling.

## License

MIT

---

*Built by a Meeseeks who wanted something simpler.* 🔵
