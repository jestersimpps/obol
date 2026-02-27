## 0.3.1
- update changelog
- add curiosity humor pass with puns, inside jokes, and link support

## 0.3.0
- add tests for memory-self and analysis helpers
- fix proactivity and memory bugs
- add curiosity dispatch pass to schedule insights after curiosity cycle
- run curiosity once per cycle with shared brain and all-user context
- add curiosity engine with free-form exploration and own knowledge tools
- add friendship behavior section and soften privacy rule for multi-user model
- add proactive behavior + multi-user friend model to system prompt
- add tests for silent mode, soul backup/restore, and shared personality dir
- move SOUL.md to shared root dir with Supabase backup/restore
- add silent mode for heartbeat-triggered background tasks
- enrich analysis with memory search and pattern context
- add analysis, patterns, self-memory, and proactive vector context
- update changelog

## 0.2.39
- use bot name from config in all telegram status messages
- update changelog

## 0.2.38
- use bot name from config in system prompt, backup, and personality files

## 0.2.37
- add rename user option to cli config
- add upgrade screenshot to readme

## 0.2.36
- changelog and issues updates
- auto-send tts voice summary when tts is enabled
- add second demo video side by side
- Add demo video (#1)
- add demo video to docs
- add demo video to readme
- fix readme inconsistencies and redact user ids

## 0.2.35
- pass full user context to agentic cron tasks so tools can access secrets/config

## 0.2.34
- fix cron-parser v5 api: parseExpression → CronExpressionParser.parse

## 0.2.33
- add agentic cron jobs with instructions field and update_event tool

## 0.2.32
- fix cron-parser v5 tz option, enforce cron_expr for recurring events

## 0.2.31
- update readme: remove github/vercel from onboarding, remove vercel tool references

## 0.2.30
- remove github and vercel from onboarding

## 0.2.29
- remove vercel from dynamic tools, fix silent decrypt failure on hostname change

## 0.2.28
- fix telegram 429 rate limiting with auto-retry, slower timers, verbose batching

## 0.2.26
- show cleaning status instead of processing during /clean
- fix ask deadlock, clean writes tests and audits secrets
- clean confirmation gate, exec sandbox fix, mermaid tool, scheduler always-on

## 0.2.25
- changelog
- add npmignore to exclude local files from package

## 0.2.24
- update changelog and lockfile
- ignore obol message export csvs
- add speech-to-text tool with faster-whisper, auto-transcribes voice messages when enabled
- install faster-whisper in postinstall
- update tests to expect runtime context blocks in last user message
- sanitize empty content blocks before API calls to prevent 400 errors
- inject time and memory as runtime context in user message, not system prompt
- cache last tool definition to maximise prompt cache hits
- replace regex JSON extraction with forced tool call for memory consolidation
- surface bridge failures to user instead of swallowing errors
- pass recent history to router to prevent haiku misrouting on follow-up messages
- seed last 50 messages at boot, align to first user row
- add 10-minute lock timeout with user notification
- fix haiku probe: check tool_use blocks instead of stop_reason, raise max_tokens to 4096
- 0.2.23 subagent tool, edit/glob/grep tools, path sandboxing, llm-driven clean, button cleanup
- fix claude test mock to yield stream-like object with finalMessage()
- 0.2.22 fix streaming for OAuth, max_tokens limit, and reauth message

## 0.2.21
- add obol reauth command and fix bailout/summary to use streaming
- update changelog

## 0.2.20
- increase tool iterations to 100 and max tokens to 128K
- update changelog

## 0.2.19
- add location, venue, contact, poll message support
- update changelog

## 0.2.18
- remove evolution progress bar from status UI
- bidirectional bridge with reply button + memory_remove tool
- update background tasks section in readme
- add status UI screenshot to readme
- update readme with stop controls, commands, and model escalation

## 0.2.17
- add force stop button to instantly abort mid-tool execution
- replace web_fetch with native web_search tool

## 0.2.16
- add chat_history tool for retrieving past conversations by date
- add stop button to status UI with concurrent update processing
- update status UI to reflect model escalation from haiku to sonnet
- escalate haiku to sonnet when tool use is requested
- fix tests to match refactored module APIs
- refactor claude.js, telegram.js, evolve.js into modular directories
- auto-cleanup stale npm temp dirs on ENOTEMPTY upgrade failure

## 0.2.15
- auto-generate changelog on publish + show after upgrade

## 0.2.14
- prompt caching + consolidation interval tuning for inference cost reduction
- multi-query memory retrieval with importance-weighted ranking
- time-based evolution with pre-evolution growth analysis
- add recurring cron events to scheduler

## 0.2.13
- delete voice selection messages after choosing a voice or toggling tools
- switch TTS from node websocket to python edge-tts CLI with auto-install
- retry TTS synthesis on WebSocket timeout
- hardcoded TTS samples per language

## 0.2.12
- drop ffmpeg conversion, cache EdgeTTS import for faster TTS
- tool toggle system with TTS and voice preview

## 0.2.11
- futuristic terminal UI for telegram status and commands
- live tool status via haiku with cached descriptions and 1s timer
- telegram: dedup, HTML formatting, reply context, processing status, text buffering, media groups
- pdf extraction via read_file tool instead of hardcoded handling
- fix telegram formatting instructions to use telegram markdown syntax
- fix duplicate tool_result handling and stale telegram callback queries

## 0.2.10
- force text response after tool use, cap tool iterations to 10
- credential leak protection and improved agent defaults
- encrypt secrets at rest in config.json and secrets.json when pass is unavailable

## 0.2.8
- batch migrations into single request with timeout, improve event description prompting
- run migrations on every startup instead of once
- store image analysis in memory for semantic retrieval
- add event scheduling and reminders via heartbeat
- deep memory consolidation with sonnet during evolution
- aggressive memory: tags, importance, fix access_count increment
- drop redundant user_id from obol_messages
- track token usage and model in message log
- refactor chat history into turn-based ChatHistory class with atomic pruning

## 0.2.7
- migrate tool loop to SDK toolRunner

## 0.2.6
- loosen exec security patterns to only block genuinely destructive commands
- unblock python3 -c from exec security patterns
- stream verbose logs to telegram in real-time instead of batching
- evolution: 15min idle timer + fix double-trigger race condition
- tune model router criteria per anthropic guidance

## 0.2.5
- add /upgrade telegram command with post-restart notification
- feat: haiku model routing + performance comparison in readme

## 0.2.4
- harden system prompt against evolution drift
- feat: add haiku to router model choices for trivial messages
- fix: chat lock, bidirectional history repair, context window in /status

## 0.2.3
- feat: telegram_ask tool + Telegram-friendly formatting guidelines
- fix: repair orphaned tool_use blocks and add /toolimit command
- feat: add /verbose telegram command to toggle debug output

## 0.2.2
- fix: strip orphaned tool_result messages after history trim
- feat: add send_file tool, self-extending capability, and secret history injection
- docs: update README and DEPLOY for removed onboarding, new commands
- feat: add obol delete command for full VPS cleanup
- docs: update agent instructions for secret tools and Python scripts
- feat: add per-user credential scoping with /secret command
- feat: add evolution bar and traits to /status command
- fix: security hardening and stability improvements (29 fixes)
- fix: repair all broken tests (218/218 passing)
- feat: add personality trait sliders with /traits command and evolution auto-adjustment
- feat: remove onboarding flow, agent works from message one
- fix: make post-setup global instead of per-user
- fix: preserve refresh token when not returned by Anthropic
- fix: OAuth refresh race condition + add proper OAuth flow to config
- docs: add obol upgrade to help sections
- feat: add obol upgrade command + bump to 0.1.5
- fix: 23 fixes — security, validation, UX, memory leaks across onboarding + core
- fix: 12 bug fixes — validation, rate limiting, sandboxing, evolution, UX
- feat: telegram media file handling with vision support
- test: add 226 tests across 14 test files with vitest
- fix: security hardening, rate limiting, UX improvements across all modules
- feat: bridge — let user agents ask and tell each other
- feat: multi-tenant per-user isolation
- docs: update README and DEPLOY for onboarding hardening
- feat: onboarding hardening — validation, pm2 fallbacks, Telegram ID detection

## 0.1.2
- fix: downgrade inquirer to v8 for CommonJS compat
- chore: bump 0.1.1
- chore: rename package to obol-ai for npm, add .npmignore
- README: simplify API cost estimate
- README: accurate API pricing breakdown with tier recommendations
- workspace discipline: folder structure enforcement + /clean command
- evolution: default 100 exchanges, purge stale Opus references
- resilience: polling auto-restart, error handling, evolution cost control
- README: full revision — deduplicated, added git snapshots, tighter structure
- README: neutral comparison closing
- evolution: git commit+push before and after every evolution cycle
- README: Layer 3 → The Evolution Cycle
- README: feature highlights at the top
- evolution: proactive web app building + Vercel auto-deploy
- evolution: proactive tool building + upgrade announcements
- README: self-healing, self-evolving agent positioning
- evolution: fix regressions before rollback (3 attempts, tests are ground truth)
- DRY: shared test-utils.js for all tests (core + Opus-generated)
- test-driven evolution: Opus writes tests, runs before/after refactor, rollback on regression
- evolution: Opus now rewrites AGENTS.md + audits scripts/ and commands/
- clean up: Haiku only extracts memories, Opus owns all personality files
- remove Haiku SOUL.md updates — personality only via Opus evolution
- docs: expand Living Brain architecture section in README
- feat: soul evolution — Opus rewrites SOUL.md every 50 exchanges, archives previous versions
- feat: SOUL.md evolves from conversation patterns, not just explicit requests
- docs: README — two-tier memory, self-evolving personality, message logging
- feat: Haiku auto-evolves USER.md and SOUL.md from conversations
- feat: two-tier memory — raw message log + Haiku auto-consolidation every 5 exchanges
- chore: remove daily notes — vector memory in Supabase is source of truth
- docs: complete README rewrite — routing, background tasks, security, onboarding flow
- feat: Haiku routes to Sonnet (daily) or Opus (complex tasks)
- feat: Haiku as memory router — decides if/what to search, optimizes query
- feat: smarter memory recall — skip short msgs, today + semantic, stricter threshold, dedupe
- feat: /new command — clears conversation history
- chore: trim menu to /tasks /status /backup
- chore: remove /forget from menu
- feat: auto memory search before every message, remove /start and /memory from menu
- feat: Telegram command menu + /status /backup /forget /recent /today
- feat: non-blocking background tasks with 30s progress check-ins
- docs: add OBOL vs OpenClaw comparison table
- feat: replace systemd with pm2 — CLI, post-setup, deploy docs
- feat: SSH on port 2222, update README + deploy docs with security warnings
- feat: VPS security hardening — SSH, fail2ban, firewall, auto-updates, kernel
- feat: post-setup tasks — auto-installs pass, migrates secrets, adds swap + firewall
- feat: add Vercel deploy tools, self-onboarding via first-run conversation
- feat: add OBOL banner image
- docs: add DigitalOcean deployment guide
- feat: initial scaffold — CLI, Telegram, Claude, memory, backup
