# 🪙 OBOL

![OBOL](docs/obol-banner.png)

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
- 🚀 Vercel deployments (build & ship sites through chat)
- 🪙 Self-onboarding — OBOL learns about you through conversation

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
- **Deploy** — Build and ship websites to Vercel through chat
- **Self-setup** — First conversation teaches OBOL who you are; it writes its own personality
- **Personality** — Customizable via SOUL.md / USER.md / AGENTS.md
- **Backup** — Auto-commits brain to private GitHub repo daily
- **Heartbeat** — Periodic background tasks
- **Auto-hardening** — SSH (port 2222), fail2ban, firewall, auto-updates, kernel security

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
- GitHub account (for backups + repos)
- Vercel account (free tier, for deploying sites)

## Memory

OBOL uses local embeddings (`all-MiniLM-L6-v2`, ~30MB, runs on CPU) with Supabase pgvector for storage. No OpenAI API needed for memory.

Memory categories: `fact`, `preference`, `decision`, `lesson`, `person`, `project`, `event`, `conversation`, `resource`, `pattern`, `context`

## Personality

Edit files in `~/.obol/personality/` to customize your bot:

- **SOUL.md** — Who is the bot? Its voice, humor, values
- **USER.md** — Who are you? Context about the owner
- **AGENTS.md** — How should it work? Tools, safety, workflows

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

## OBOL vs OpenClaw

| | **OBOL** | **OpenClaw** |
|---|---|---|
| **Setup** | ~10 min (6 inputs + chat) | 30-60 min (config, plugins, channels) |
| **Channels** | Telegram | Telegram, Discord, Signal, WhatsApp, IRC, Slack, iMessage + more |
| **LLM** | Anthropic (Claude) | Anthropic, OpenAI, Google, Groq, local models |
| **Memory** | Supabase pgvector + local embeddings | Pluggable (file-based, vector, custom) |
| **Architecture** | Single process | Gateway daemon + session management |
| **Tools** | Built-in (exec, files, web, memory, Vercel) | Extensible skill system with policies |
| **Security** | Auto-hardens VPS on first run | Manual (healthcheck skill) |
| **Sub-agents** | — | Full spawning, isolated sessions |
| **Onboarding** | Bot teaches itself who you are | You configure everything upfront |
| **Backup** | Auto GitHub backup daily | Manual / custom |
| **Model switching** | — | Per-session overrides, fallback chains |
| **Group chats** | — | Full group support with context |
| **Context compaction** | — | Automatic for long sessions |
| **Cron** | Basic node-cron | Full scheduler with isolated sessions |
| **Config** | 1 JSON file → `pass` | YAML, hot-reload, schema validation |
| **Cost** | ~$9/mo | ~$9/mo + more if multi-provider |

**OBOL is better when you want** zero-to-running speed, self-configuring personality, automatic VPS hardening, simplicity, and a brain that backs itself up to GitHub without you thinking about it.

**OpenClaw is better when you need** multi-channel, multi-provider, sub-agents, group chats, context compaction, skill systems, and deep customization.

They're not competitors — OBOL is the on-ramp. When you outgrow it, graduate to [OpenClaw](https://openclaw.ai).

## License

MIT

---

*Built by a Meeseeks who wanted something simpler.* 🔵
