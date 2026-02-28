const { resolveDelay } = require('./utils/timing');

const ANALYSIS_WINDOW_MS = 3 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 1000;
const MAX_TRANSCRIPT_CHARS = 40000;

async function runAnalysis(client, messageLog, scheduler, patterns, memory, userId, chatId, timezone) {
  const since = new Date(Date.now() - ANALYSIS_WINDOW_MS);
  const messages = await messageLog.getSince(chatId, since);

  if (messages.length === 0) {
    console.log(`[analysis] No messages in last 3h for user ${userId}`);
    return;
  }

  console.log(`[analysis] Analyzing ${messages.length} messages for user ${userId}`);

  const transcript = buildTranscript(messages);
  const report = await generateReport(client, memory, transcript, timezone);
  if (!report) return;

  await structureReport(client, report, scheduler, patterns, chatId, timezone);

  console.log(`[analysis] Complete for user ${userId}`);
}

function buildTranscript(messages) {
  let transcript = '';
  for (const msg of messages) {
    const ts = new Date(msg.created_at).toLocaleString('en-US');
    const content = msg.content.substring(0, MAX_MESSAGE_CHARS);
    transcript += `[${ts}] ${msg.role.toUpperCase()}: ${content}\n\n`;
    if (transcript.length > MAX_TRANSCRIPT_CHARS) break;
  }
  return transcript.trim();
}

async function generateReport(client, memory, transcript, timezone) {
  const since = new Date(Date.now() - ANALYSIS_WINDOW_MS);
  const memories = memory ? await memory.query({ since, limit: 100 }).catch(() => []) : [];
  const memoryContext = memories.length
    ? `\nWhat you already know about them:\n${memories.map(m => `- ${m.content}`).join('\n')}`
    : '';

  const system = `You are analyzing a conversation transcript to understand the HUMAN in it. Write a report about THEIR behavior, personality, and patterns.

1. INTENTIONS & FOLLOW-UPS: Intentions they expressed, upcoming events, pending tasks, or things worth a natural check-in later. Be selective — only things a friend would genuinely remember.

2. BEHAVIORAL PATTERNS (about the human, not about yourself):
   - Timing: when they message, active windows, energy by day/time
   - Mood signals: emotional baseline, stress indicators, good/bad day signals
   - Humor style: what lands, banter comfort, comedic preferences
   - Engagement depth: which topics generate longer responses, what they bring up unprompted
   - Communication style: message length, formality, response patterns
   - Recurring topics: what keeps coming up, what lights them up, what they avoid

IMPORTANT: Only describe the human's behavior. Every observation must be about what the human said or did.

Write candidly and specifically. "Active between 9-11pm" beats "sometimes active at night". Skip categories with no signal. Timezone context: ${timezone}.${memoryContext}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: `Conversation transcript:\n\n${transcript}` }],
    });

    const text = response.content.find(b => b.type === 'text');
    return text?.text || null;
  } catch (e) {
    console.error('[analysis] Report generation failed:', e.message);
    return null;
  }
}

async function structureReport(client, report, scheduler, patterns, chatId, timezone) {
  const formattedPatterns = patterns
    ? await patterns.format().catch(() => null)
    : null;

  const saveTool = [{
    name: 'save_analysis',
    description: 'Save structured analysis data from the analytical report',
    input_schema: {
      type: 'object',
      properties: {
        follow_ups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              due_at: { type: 'string', description: 'ISO 8601 date or datetime in the user\'s local time, e.g. "2024-03-15" or "2024-03-15T20:00"' },
              context: { type: 'string', description: 'Brief context for the follow-up message' },
            },
            required: ['description', 'due_at', 'context'],
          },
        },
        patterns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Stable dot-notation identifier for this pattern, e.g. "timing.active_hours", "mood.stress_signals", "humor.style"' },
              dimension: { type: 'string', enum: ['timing', 'mood', 'humor', 'engagement', 'communication', 'topics'] },
              summary: { type: 'string', description: 'Factual observation about the user, e.g. "Most active between 7-10pm on weekdays", "Uses sarcasm and dry humor when relaxed"' },
              data: { type: 'object', description: 'Factual evidence only. Examples: {"peak_hours":["19:00-22:00"],"peak_days":["mon","wed","fri"]} or {"preferred_topics":["crypto","music"]} or {"avg_message_length":"short","uses_caps":false}. Never put notes, commentary, or meta-analysis here.' },
              confidence: { type: 'number', description: '0-1' },
            },
            required: ['key', 'dimension', 'summary', 'confidence'],
          },
        },
      },
      required: ['follow_ups', 'patterns'],
    },
  }];

  try {
    const localTime = new Date().toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' });
    const patternGuidance = `Extract behavioral patterns about the human from the report. Each pattern must describe something the HUMAN does — how they write, when they're active, what they talk about, how they respond. Never include patterns about your own behavior, tool usage, analysis approach, or system processes. If you see the same pattern in the existing list, reuse its exact key and update the summary/confidence. Skip patterns already at confidence >0.8 unless new evidence contradicts them.`;
    const timingGuidance = `Current local time for this user: ${localTime}. For each follow-up, pick a specific date or datetime in the user's local time based on what you know from the transcript. Use ISO 8601 format: "2024-03-15" for date-only or "2024-03-15T20:00" for exact time.`;

    const system = formattedPatterns
      ? `Existing behavioral patterns for this user:\n${formattedPatterns}\n\n---\n\n${patternGuidance}\n\n${timingGuidance}`
      : `Convert this analytical report into structured data using the save_analysis tool. ${patternGuidance}\n\n${timingGuidance}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system,
      tools: saveTool,
      tool_choice: { type: 'tool', name: 'save_analysis' },
      messages: [{ role: 'user', content: report }],
    });

    const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'save_analysis');
    if (!toolUse) return;

    const followUps = toolUse.input?.follow_ups || [];
    const patternList = toolUse.input?.patterns || [];

    const timingPattern = patterns ? await patterns.get('timing.active_hours').catch(() => null) : null;
    const timingData = timingPattern?.data || null;

    for (const fu of followUps) {
      if (!fu.description || !fu.due_at) continue;
      const dueAt = resolveDelay(fu.due_at, timezone, timingData);
      const instructions = `You mentioned checking in on: "${fu.description}". Context: ${fu.context || ''}. Reach out naturally — like a friend who remembered. Keep it casual, one line. Don't reference any system or task.`;
      await scheduler.add(chatId, 'Proactive follow-up', dueAt, timezone, fu.description, null, null, null, instructions).catch(e =>
        console.error('[analysis] Failed to schedule follow-up:', e.message)
      );
    }

    for (const p of patternList) {
      if (!p.key || !p.dimension || !p.summary) continue;
      const existing = await patterns.get(p.key).catch(() => null);
      const save = existing ? patterns.incrementObservation : patterns.upsert;
      await save(p.key, p.dimension, p.summary, p.data || {}, p.confidence || 0.5).catch(e =>
        console.error('[analysis] Failed to save pattern:', e.message)
      );
    }

    console.log(`[analysis] Saved ${followUps.length} follow-ups, ${patternList.length} patterns`);
  } catch (e) {
    console.error('[analysis] Structuring failed:', e.message);
  }
}

module.exports = { runAnalysis, buildTranscript };
