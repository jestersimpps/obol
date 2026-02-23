/**
 * Message logging + periodic consolidation to vector memory.
 * 
 * Tier 1: obol_messages — raw log, every message, no embeddings
 * Tier 2: obol_memory — vector, Haiku summarizes every ~5 exchanges
 */

const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('./config');

class MessageLog {
  constructor(supabaseConfig, memory, claudeClient) {
    this.url = supabaseConfig.url;
    this.headers = {
      'apikey': supabaseConfig.serviceKey,
      'Authorization': `Bearer ${supabaseConfig.serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
    this.memory = memory;
    this.client = claudeClient;
    this.exchangeCount = new Map(); // chatId -> count since last consolidation
  }

  /**
   * Log a message (fire and forget)
   */
  async log(chatId, role, content, opts = {}) {
    try {
      await fetch(`${this.url}/rest/v1/obol_messages`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          chat_id: chatId,
          role,
          content: content.substring(0, 50000), // cap at 50k
          model: opts.model || null,
          tokens_in: opts.tokensIn || null,
          tokens_out: opts.tokensOut || null,
        }),
      });
    } catch {} // Best effort

    // Track exchanges for consolidation
    if (role === 'assistant') {
      const count = (this.exchangeCount.get(chatId) || 0) + 1;
      this.exchangeCount.set(chatId, count);

      // Consolidate every 5 exchanges
      if (count >= 5) {
        this.exchangeCount.set(chatId, 0);
        this.consolidate(chatId).catch(() => {});
      }
    }
  }

  /**
   * Get recent messages for context loading on boot
   */
  async getRecent(chatId, limit = 20) {
    try {
      const res = await fetch(
        `${this.url}/rest/v1/obol_messages?chat_id=eq.${chatId}&order=created_at.desc&limit=${limit}&select=role,content,created_at`,
        { headers: this.headers }
      );
      const data = await res.json();
      return data.reverse(); // oldest first
    } catch {
      return [];
    }
  }

  /**
   * Haiku consolidates recent messages into vector memory
   */
  async consolidate(chatId) {
    if (!this.memory || !this.client) return;

    try {
      // Get last 10 messages
      const messages = await this.getRecent(chatId, 10);
      if (messages.length < 4) return; // Not enough to consolidate

      const transcript = messages.map(m =>
        `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content.substring(0, 500)}`
      ).join('\n');

      // Ask Haiku to extract memories AND personality updates
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-20250514',
        max_tokens: 800,
        system: `Analyze this conversation and extract TWO things:

1. **memories** — important facts worth remembering long-term
2. **personality_updates** — things that should update the bot's core files

Return JSON:
{
  "memories": [
    {"content": "concise fact", "category": "fact|preference|decision|lesson|person|project|event|conversation|resource|pattern|context"}
  ],
  "user_updates": ["New fact about the owner to append to USER.md"],
  "soul_updates": ["New personality trait or behavior change to append to SOUL.md"]
}

MEMORIES — Skip: greetings, small talk. Keep: facts, decisions, preferences, people, projects, events.

USER_UPDATES — The owner revealed something about themselves: job change, new location, new relationship, hobby, preference about how the bot should address them, timezone change, contact info. Only real personal facts, not conversation topics.

SOUL_UPDATES — Ways the bot should evolve based on the conversation. Both explicit requests ("be more casual", "stop using emojis") AND inferred patterns: if the owner uses humor → the bot should match. If conversations are technical → note the technical depth expected. If the owner seems to prefer short replies → note that. Capture the emerging relationship dynamic and communication style.

Return empty arrays if nothing applies.`,
        messages: [{ role: 'user', content: transcript }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const extracted = JSON.parse(jsonMatch[0]);

      // Store memories
      if (extracted.memories?.length) {
        for (const mem of extracted.memories) {
          if (mem.content && mem.content.length > 10) {
            await this.memory.add(mem.content, {
              category: mem.category || 'conversation',
              importance: 0.5,
              source: 'auto-consolidation',
            });
          }
        }
      }

      // Append to USER.md
      if (extracted.user_updates?.length) {
        const userPath = path.join(OBOL_DIR, 'personality', 'USER.md');
        if (fs.existsSync(userPath)) {
          const current = fs.readFileSync(userPath, 'utf-8');
          const additions = extracted.user_updates
            .filter(u => u && !current.includes(u))
            .map(u => `- ${u}`)
            .join('\n');
          if (additions) {
            fs.appendFileSync(userPath, `\n\n## Learned ${new Date().toISOString().slice(0, 10)}\n${additions}\n`);
          }
        }
      }

      // Append to SOUL.md
      if (extracted.soul_updates?.length) {
        const soulPath = path.join(OBOL_DIR, 'personality', 'SOUL.md');
        if (fs.existsSync(soulPath)) {
          const current = fs.readFileSync(soulPath, 'utf-8');
          const additions = extracted.soul_updates
            .filter(u => u && !current.includes(u))
            .map(u => `- ${u}`)
            .join('\n');
          if (additions) {
            fs.appendFileSync(soulPath, `\n\n## Updated ${new Date().toISOString().slice(0, 10)}\n${additions}\n`);
          }
        }
      }
    } catch {} // Best effort
  }
}

function createMessageLog(supabaseConfig, memory, claudeClient) {
  return new MessageLog(supabaseConfig, memory, claudeClient);
}

module.exports = { createMessageLog };
