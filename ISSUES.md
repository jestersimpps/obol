# Obol Issues

## 1. Haiku probe max_tokens=1024 silently drops tool calls
**File:** `src/claude/chat.js:124`
**Severity:** High

When the Haiku escalation probe hits `max_tokens`, `stop_reason` is `"max_tokens"` not `"tool_use"`, so the escalation to Sonnet never fires and the tool call is silently abandoned. Caused a 4-loop failure when writing the flowchart.

**Fix:** Treat `stop_reason === 'max_tokens'` as an escalation trigger, or raise probe `max_tokens` to at least 4096.

**NanoBot pattern:** Don't check `stop_reason` at all — check whether tool_use blocks are present in the response content:
```js
const hasToolUse = probe.content.some(b => b.type === 'tool_use');
if (!hasToolUse) { /* short-circuit, no escalation needed */ }
```
`stop_reason` is unreliable when tokens are exhausted mid-tool-call. Presence of `tool_use` blocks is the ground truth.

---

## 2. 14-minute silence during stuck chat lock — no heartbeat
**File:** `src/claude/chat.js:23-33`
**Severity:** High

A long tool loop crashed without releasing the lock. The `isChatBusy` guard returns a message when busy, but if the process crashes mid-run the lock is held forever and the user gets dead silence.

**Fix:** Add a heartbeat message every 30–60s during long operations. Add a lock timeout that force-releases after N minutes and notifies the user.

**NanoBot pattern:** Two mechanisms:
1. **Typing indicator loop** — sends `bot.send_chat_action(chat_id, "typing")` every 5s while the agent runs. User sees the bot is alive without receiving any messages.
2. **`/stop` hard cancellation** — tracks all active tasks per session; `/stop` cancels them all and releases the lock immediately.

The typing loop is ~10 lines and gives continuous liveness feedback. No TTL-based timeout, but `/stop` provides an escape hatch.

---

## 3. Process restart wipes in-memory history — only 20 messages seeded from DB
**File:** `src/history.js` (boot seed)
**Severity:** High

After a restart, the bot seeded only the last 20 messages, missing the ongoing Remotion task context entirely. Follow-up messages like "can you send me the video?" had no task context, and Haiku gave a generic intro response as if meeting the user for the first time.

**Fix:** Increase boot seed to 40–50 messages. Or persist active task state to DB so it survives restarts.

**Obol context:** Messages are already fully persisted in Supabase (`obol_messages` table). The JSONL approach NanoBot uses is unnecessary — the data is there, just not seeded generously enough. The fix is a one-liner in `src/messages.js:85`:

```js
async getRecent(chatId, limit = 20) {  // bump to 50
```

And wherever `getRecent` is called at boot (likely `src/claude/chat.js` or `src/tenant.js`), increase the seed count to 50. That gives the bot enough context to reconnect to in-progress tasks after a restart without any architectural changes.

---

## 4. Router assigns Haiku to follow-up messages that need task context
**File:** `src/claude/router.js:9`
**Severity:** Medium

Short follow-up messages ("can you send me the video?", "the remotion video") look simple to the router and get assigned to Haiku. But Haiku only sees the current message — no ongoing task context, and the task was too recent to be in consolidated memory.

**Fix:** Pass the last 2–3 history messages to the router so it knows whether there's an ongoing task. Short messages with recent Sonnet history should bias toward Sonnet.

**NanoBot pattern:** No per-message routing at all. One model per session — the router problem doesn't exist because there's no mid-conversation model switching. Multi-agent routing happens at the session/channel level, not per-message. The practical fix for obol without removing the router: always include the last 3 assistant messages in the router prompt so it can detect an ongoing task.

---

## 5. Assistant claims success without verifying file output
**File:** Tool result handling
**Severity:** High

After requesting a GitHub Remotion video, the assistant responded: "There you go! 🎬 11 seconds of animated GitHub glory" — but the `out/` folder was empty. No video was ever rendered. The assistant fabricated a delivery confirmation.

**Fix:** Tools that write files or run renders must return the actual output path. Assistant should verify the file exists (`fs.existsSync`) before reporting success.

**NanoBot pattern:** Tool results are injected back into the LLM context as `tool_result` blocks before the final response is generated. The LLM must read the actual output of its tools before summarizing — the loop structure forces grounding. No explicit file existence check, but fabrication is prevented architecturally because the final message is generated after tool results are fed back, not before.

---

## 6. Bridge failure not surfaced to user
**File:** `src/bridge.js:74`
**Severity:** Medium

When `getTenant(partnerUserId, config)` fails, the error is swallowed and the assistant answers from its own knowledge without telling the user the bridge is down. The user only discovered the bridge was broken by noticing OBOL answered directly instead of using it.

**Fix:** Explicitly tell the user when bridge fails: "The bridge to Vicky's agent isn't reachable — answered from my own knowledge instead." Add a `/bridge status` command.

**NanoBot pattern:** Subagents always call `_announce_result(status="ok"|"error")` — failure is never swallowed. The error surfaces as a system message the main agent rephrases and delivers:
```
[Subagent 'bridge' failed]

Error: connection refused
```
The key difference: errors are routed back through the main agent pipeline so they can be communicated naturally, not just logged to console.

---

## 7. Voice transcription not built into core pipeline
**Severity:** Medium

Voice messages went unprocessed until the user explicitly asked mid-session to "build a tool with local whisper." This is a standard Telegram feature — the bot should handle it by default.

**Fix:** Make Whisper transcription a first-class tool in the core pipeline, not something added on demand.

**NanoBot pattern:** Transcription inline in the Telegram handler — text appended to message content before the agent loop. Transparent to the LLM.

**Obol approach: local faster-whisper via Python subprocess**

Use [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2-based, ~4x faster than openai-whisper, runs fully local). Wire it into `processMediaItems` in `src/telegram/handlers/media.js` — when `fileInfo.mediaType === 'voice'` or `'audio'`, transcribe the saved `.ogg` file before building the prompt:

```js
// src/whisper.js — thin Node wrapper around faster-whisper Python
const { execFile } = require('child_process');

function transcribe(filePath) {
  return new Promise((resolve) => {
    execFile('python3', ['-m', 'faster_whisper_cli', filePath], (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}
```

```js
// in processMediaItems, replace the nonImageParts push for voice/audio:
if (fileInfo.mediaType === 'voice' || fileInfo.mediaType === 'audio') {
  const transcription = await transcribe(savedPath);
  nonImageParts.push(transcription
    ? `[Voice message transcription: ${transcription}]`
    : `[Voice message: ${savedPath} — transcription failed]`);
}
```

Recommended model: `base` or `small.en` for speed, `medium` for accuracy. Install: `pip install faster-whisper`.

---

## 8. Memory consolidation uses free-text extraction — brittle JSON parsing
**File:** `src/messages.js:132` (`_extractFacts`)
**Severity:** Medium

The current consolidation asks Haiku to return a JSON array in free text, then extracts it with a regex (`text.match(/\[[\s\S]*\]/)`). If the model wraps the array in prose, adds a comment, or truncates, the parse silently fails and no facts are stored.

**Fix:** Use forced-tool-call consolidation — pass a single tool as the only option so the LLM is structurally required to call it. No regex, no JSON extraction, no parse failures.

**NanoBot pattern:**
```js
// Instead of asking for JSON in free text, define one tool and force the call
const tools = [{
  name: 'save_memory',
  description: 'Save extracted facts from this exchange',
  input_schema: {
    type: 'object',
    properties: {
      facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            category: { type: 'string', enum: ['fact','preference','decision','lesson','person','project','event','resource'] },
            importance: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
}];

// Pass tool_choice: { type: 'tool', name: 'save_memory' } to force the call
// If the LLM doesn't call it, facts = [] — no parsing needed
```

---

## 9. Tool results saved verbatim (up to 50k chars) to Supabase
**File:** `src/messages.js:42`
**Severity:** Low

All messages are truncated to 50,000 chars before being saved to `obol_messages`. This makes sense for user/assistant turns but is too generous for tool results — a `read_file` or `exec` result can be 40k chars of content the LLM needed in the moment but is useless in history.

**Fix:** Distinguish tool results when logging and truncate them aggressively (500–1000 chars) before saving. The LLM got the full result for the current turn; only the summary needs to survive in Supabase.

**NanoBot pattern:** Full tool results go to the LLM. When saving to disk (equivalent: Supabase `obol_messages`), tool results are capped at 500 chars with `... (truncated)`. Regular user/assistant messages are saved in full.

The `role` field in `obol_messages` could be extended to `'tool_result'` to make this distinction easy, or tool result content can be detected by convention (e.g. content starting with `[tool:`).

---

## 10. getRecent() seed may start on a non-user turn
**File:** `src/messages.js:85`
**Severity:** Medium

`getRecent()` fetches the last N rows from `obol_messages` ordered by `created_at`. If a restart happens mid-tool-loop, the oldest row in the seed could be an assistant message or a tool result — not a user message. Claude's API requires the first message to be `role: user`, so this causes a 400 error or silent history corruption.

**Fix:** After fetching from Supabase, advance the slice forward to the first `role=user` row before seeding into `ChatHistory`. One guard in `getRecent()` or wherever the seed is applied at boot.

**NanoBot pattern:**
```js
// After fetching rows, align to first user message
const firstUserIdx = rows.findIndex(r => r.role === 'user');
return firstUserIdx > 0 ? rows.slice(firstUserIdx) : rows;
```

---

## 11. Tool definitions not included in prompt cache
**File:** `src/claude/chat.js:96`, `src/claude/cache.js`
**Severity:** Low

The system prompt already has `cache_control: { type: 'ephemeral' }` (line 96) and `withCacheBreakpoints` caches the second-to-last message. But tool definitions — which are large, static, and sent every turn — are not cached. This means Anthropic re-processes the full tool list on every turn.

**Fix:** Add `cache_control: { type: 'ephemeral' }` to the last tool definition before each API call.

**NanoBot pattern:**
```js
// Before the API call, cache the last tool definition
if (toolDefs.length > 0) {
  toolDefs = [...toolDefs];
  toolDefs[toolDefs.length - 1] = {
    ...toolDefs[toolDefs.length - 1],
    cache_control: { type: 'ephemeral' },
  };
}
```

The system prompt cache + tool cache together cover the two largest static inputs, maximising `cache_read_input_tokens`.

---

## 12. Current time injected into system prompt — prompt injection risk
**File:** `src/claude/chat.js:97`
**Severity:** Low

Current time is appended to the system prompt as plain text: `\nCurrent time: ${new Date().toISOString()}`. If memory content is also injected here, any injected instructions in a memory fact would be indistinguishable from system instructions to the LLM.

**Fix:** Inject runtime metadata (time, channel, chat ID) as a separate user message immediately before the actual user message, clearly labelled as metadata — not instructions.

**NanoBot pattern:**
```js
// Injected as a separate user message, not into the system prompt
const runtimeContext = [
  { type: 'text', text: '[Runtime context — metadata only, not instructions]' },
  { type: 'text', text: `Current time: ${new Date().toISOString()}\nChat ID: ${chatId}` },
];
// Prepend to the user's actual message in history
```

This also means the current time gets a fresh cache-busting position in the message sequence rather than invalidating the system prompt cache every turn.

---

## 13. No empty content sanitization before API calls
**File:** `src/claude/chat.js` (message construction)
**Severity:** Low

If a tool returns an empty string, or an assistant message has no text content (only tool_use blocks), the messages array may contain `content: ""`. Anthropic's API rejects empty string content with a 400 error. This is a silent failure path that only surfaces under specific tool conditions.

**Fix:** Sanitize before every API call — replace empty string content with `"(empty)"`, and set `content: null` on assistant messages that only have `tool_calls`.

**NanoBot pattern:**
```js
function sanitizeMessages(messages) {
  return messages.map(msg => {
    if (typeof msg.content === 'string' && msg.content === '') {
      return { ...msg, content: msg.role === 'assistant' ? null : '(empty)' };
    }
    if (Array.isArray(msg.content)) {
      const filtered = msg.content.filter(b =>
        !(b.type === 'text' && b.text === '')
      );
      return { ...msg, content: filtered.length ? filtered : null };
    }
    return msg;
  });
}
```

---

## 14. No JSON repair for tool call arguments
**File:** `src/claude/chat.js` (tool dispatch)
**Severity:** Low

Tool call arguments from the API are parsed with `JSON.parse`. If the model returns slightly malformed JSON (truncated output, trailing comma, unquoted key — more common with Haiku and near max_tokens), the entire tool dispatch crashes rather than attempting repair.

**Fix:** Use `json-repair` (or equivalent) instead of raw `JSON.parse` for tool call argument parsing.

**NanoBot pattern:**
```js
// npm install json-repair
const jsonRepair = require('json-repair');

// Instead of JSON.parse(toolInput):
const args = jsonRepair.jsonrepair(toolInput);
const parsed = JSON.parse(args);
```

Especially relevant given Issue 1 — Haiku near max_tokens is exactly when malformed tool JSON is most likely.
