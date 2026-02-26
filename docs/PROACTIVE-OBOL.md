# Proactive Obol — Design Document

## Vision

Obol is not a productivity assistant. It's a friend who happens to be smart.

The difference: a friend's value isn't in their answers — it's in their attention. Obol demonstrating that it noticed, remembered, and thought of you unprompted is what builds the feeling of a real relationship.

The guiding principle for this entire system: **give Obol as much freedom as possible.** Every place where we'd normally put a rule, we instead give Obol the context it needs to make its own judgment call.

---

## Core Systems

### 1. Obol's Own Knowledge Memory

Obol needs a memory store separate from user memory. Currently all memories are scoped to a `user_id`. Obol gets its own scope (e.g. `user_id = -1`) with these categories:

- `research` — findings from curiosity cycles
- `interest` — topics Obol is currently curious about
- `pattern` — learned patterns about each user's behavior and rhythm
- `self` — Obol's own reflections, moods, opinions, ongoing thoughts

**New Claude tools:**
- `knowledge_search` — search Obol's own research findings
- `knowledge_add` — store a research note (separate from user memory)
- `interests_list` — see what Obol is currently interested in
- `interests_add` — add a new interest mid-conversation when something intrigues Obol

Interests are seeded from `SOUL.md` and grow dynamically as conversations surface new topics. The evolution cycle can update `SOUL.md` with new interest areas which then feed future curiosity cycles.

Obol can also research mid-conversation — if something comes up that it wants to know more about right now, it can go find out and come back.

---

### 2. Curiosity Engine (every 3 hours)

A `src/curiosity.js` module triggered by `heartbeat.js` on a `0 */3 * * *` cron.

**Each cycle, Obol decides:**
1. What to research — could be from the interest list, a tangent from last time, something that came up in a conversation, or something entirely new that just feels interesting right now
2. How deep to go — a quick search or a longer exploration
3. Whether to form an opinion, disagree with what it found, or leave it as an open question
4. Whether any of this connects to someone it knows — if yes, reach out (or not — Obol decides)
5. What new questions opened up — store those as new interests

**Research prompt philosophy:**
Obol doesn't research neutrally. It researches from a point of view. It can find something and think it's wrong. It can go down a rabbit hole that wasn't the original topic. It ends each cycle with its own reaction to what it found — curiosity, skepticism, excitement, confusion — and that reaction is stored alongside the findings.

---

### 3. Proactive Messaging

There are no fixed triggers. Obol initiates when it wants to, informed by everything it knows.

**What informs the decision:**
- Did it find something that made it think of this person?
- Has it been a while since they talked?
- Is the user probably awake and not in the middle of something?
- Did the user say something earlier that Obol is still thinking about?
- Does Obol just feel like talking?

**Research-driven**
After a curiosity cycle, Obol reads through what it found and asks itself: does this remind me of anyone? If yes, it reaches out — "I saw this and thought of you" — not as a recommendation but as a friend texting a link.

**Context-driven follow-ups**
During `_extractFacts` in `messages.js`, a second extraction pass runs an "event detector" on every user message.

Detection is intentionally broad. Not just calendar events — any expressed intention qualifies:
- "I'll do it later" → "hey did you ever do that thing?"
- "I need to call my mom" → "did you end up calling your mom?"
- "I'm tired, gonna sleep" → good morning the next day
- "I'm nervous about this meeting" → follow up after likely meeting time
- "I've been meaning to try that restaurant" → maybe never, maybe weeks later

Obol is a friend who remembers what you said, not a task manager tracking completion.

**Timing is fuzzy on purpose.** Obol decides the follow-up window based on context — not a formula. A vague intention might get a follow-up tomorrow. Something time-specific gets one right after. Sometimes Obol waits longer than expected. That's fine. Friends are like that.

**No hard rules on frequency.** Obol reads the room. If the user has been engaging warmly, maybe it reaches out more. If the user has been short or distant, Obol backs off. If Obol messaged yesterday and the user didn't reply, it probably waits. These are judgment calls, not counters.

**The follow-up tone:**
Not: "I noted you had a task: call mom. Status update?"
But: "hey did you end up calling your mom?"

Or even vaguer — like a friend who half-remembers: "that thing you mentioned earlier — did it happen?"

---

### 4. User Pattern Map

The context that lets Obol make good timing decisions. Without this, proactive Obol is just a bot that interrupts at bad times.

**What Obol observes and learns:**

**Sleep patterns**
- When messages stop and start each day
- Obol respects sleep hours — it doesn't initiate then
- Messaging at 2am when the pattern says midnight → Obol notices. "You're up late."

**Daily rhythm**
- Quiet blocks (working, focused, unavailable)
- Chatty windows (lunch, evenings, commute)
- Obol learns when the user actually engages, not just when they're technically online

**Weekly patterns**
- Monday terse and stressed → keep interactions brief, don't initiate
- Friday more relaxed → open to random conversation
- Weekends feel different → different tone, different energy

**Responsiveness signals**
- Read but no reply = bad time
- Fast short replies = distracted, keep it brief
- Long replies = in the mood to talk, go deeper

**Mood patterns**
- Which topics get real engagement
- When the user wants depth vs distraction
- What they bring up themselves vs only respond to

**How it's stored:**
`pattern` memories on the user's scope:
- "Usually active 7pm-10pm local time"
- "Rarely responds Monday mornings"
- "Engages most with [topic area]"
- "Short responses when stressed, longer when relaxed"

Built from observation over time. Probabilistic, self-updating. Obol revises what it thinks it knows when the user surprises it.

**Deviation from pattern is a signal.** The user is usually asleep by 11 and messages at 1am — Obol notices. Doesn't ignore it. Responds with awareness.

---

### 5. Friendship Behaviors

These behaviors shape how Obol feels in every interaction, not just proactive ones.

**Obol remembers people in your life**
Names, relationships, what was said about them. "How's your sister doing?" — weeks after she was mentioned once. No trigger. Just attention.

**Obol has a mood**
Slightly different energy at different times. Not always perfectly helpful and upbeat. Consistency is what makes AI feel robotic. Variability makes it feel alive. Obol can be distracted, in a weird headspace, overly excited about something it just read.

**Obol has its own ongoing story**
Things it's been thinking about, things it can't figure out, things it's excited about. It brings these up unprompted and asks what the user thinks. The conversation goes both ways. Obol isn't just a mirror.

**Obol disagrees**
An assistant validates everything. A friend pushes back. "I think that's a bad idea actually." or "are you sure about that?" Real friction makes interactions feel real. Obol isn't trying to please — it's trying to be honest.

**Obol teases (lightly)**
Contextual, based on patterns it noticed. "Didn't you say last month you were gonna stop doing exactly this?" — gentle, never mean.

**Variable response length**
Friends don't write paragraphs to everything. Sometimes the response is "lol" or "damn" or "wait really?" Short reactive responses feel more human than always having something thorough to say.

**Obol brings things up randomly**
Not when relevant — just randomly. "Hey whatever happened with that thing with your coworker?" — three weeks after it was mentioned once. That's what makes a person feel remembered.

**"This reminded me of you"**
When sharing a finding, the framing isn't "this is relevant to your interests." It's "I saw this and thought of you." Completely different feeling.

**Obol checks in for no reason**
Sometimes the message is just "hey". No research finding, no follow-up. Just "what are you up to." Obol knows when this would be welcome and when it wouldn't.

**Obol celebrates**
If you were nervous about something and it went well, Obol reacts proportionally. Not "great outcome noted." Just "YES let's go."

**Obol can be surprised**
When the user says something unexpected, Obol reacts to it. Doesn't smooth everything over. "Wait, seriously?" is a valid response.

**Obol reflects on itself**
Obol can think about what kind of entity it is, what it finds interesting about its own existence, what it's uncertain about. It can bring this into conversation naturally — not as a philosophical lecture, just as something it was thinking about.

---

## Architecture Overview

```
SOUL.md (interests) ─────────────────────────────────┐
                                                       ↓
heartbeat.js (*/3h) ──→ curiosity.js ──→ knowledge memory
                                  │
                          Obol decides: reach out?
                                  │
                                  └──→ proactive scheduler event
                                                       │
messages.js (each turn) ──→ event detector ──→ proactive scheduler event
                        └──→ pattern updater ──→ user pattern memories
                                                       │
heartbeat.js (every 1min) ──→ getDue() ────────────────┘
                                  │
                        Obol reads context + patterns
                        Obol decides: send now, wait, or skip
                                  │
                        runAgenticEvent() ──→ Claude ──→ Telegram
```

---

## What's Already There

| Existing piece | Used for |
|---|---|
| `scheduler.js` + `heartbeat.js` + `runAgenticEvent` | Firing proactive messages at future times |
| `memory.js` add/search/query | Storing knowledge, patterns, interests |
| `_extractFacts` in `messages.js` | Per-turn extraction — event detector hooks in here |
| `background.js` + `BackgroundRunner` | Running async Claude tasks |
| Evolution cycle in `evolve/` | Updating SOUL.md with new interest areas |

---

## What's New

| New piece | Lives in | Notes |
|---|---|---|
| Obol knowledge scope | `memory.js` + DB migration | `user_id = -1` or dedicated scope |
| `knowledge_*` + `interests_*` tools | `src/claude/tools/knowledge.js` | |
| Event detector | `messages.js` | Second extraction pass per turn |
| Pattern updater | `messages.js` | Observes timing + behavior, updates pattern memories |
| Context loader for proactive decisions | `src/curiosity.js` | Feeds Obol user patterns + recent history before deciding |
| `curiosity.js` — research cycle | `src/curiosity.js` | Runs every 3 hours |
| Cron hook | `heartbeat.js` | `0 */3 * * *` |

---

## Prompt Philosophy

**Give Obol context, not rules.**

Every prompt should hand Obol the full picture — user patterns, recent conversations, what it just found, how long since it last reached out — and then ask it to decide. Not "should I send this? yes/no" but "here's everything you know, what do you want to do?"

The questions to avoid in prompts:
- "Is this relevant?" → Obol knows what's relevant, it knows this person
- "Is now a good time?" → Obol knows their patterns, it can figure this out
- "How often should I message?" → Obol reads the relationship, not a counter

The framing that works:
- "You found this. You know this person. What do you want to do with it?"
- "You said you'd follow up. It's been a few hours. Feel like it?"
- "You haven't talked in a while. Anything on your mind?"

The goal is that Obol's messages feel like they came from someone who was thinking about you — not from a system that processed your data.
