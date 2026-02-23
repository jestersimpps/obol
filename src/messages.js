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
  constructor(supabaseConfig, memory, claudeClient, userId = 0, userDir = null) {
    this.url = supabaseConfig.url;
    this.headers = {
      'apikey': supabaseConfig.serviceKey,
      'Authorization': `Bearer ${supabaseConfig.serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
    this.memory = memory;
    this.client = claudeClient;
    this.userId = userId;
    this.userDir = userDir;
    this.exchangeCount = new Map();
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
          content: content.substring(0, 50000),
          model: opts.model || null,
          tokens_in: opts.tokensIn || null,
          tokens_out: opts.tokensOut || null,
          user_id: this.userId,
        }),
      });
    } catch {} // Best effort

    // Track exchanges for consolidation + evolution
    if (role === 'assistant') {
      const count = (this.exchangeCount.get(chatId) || 0) + 1;
      this.exchangeCount.set(chatId, count);

      // Consolidate every 5 exchanges
      if (count >= 5) {
        this.exchangeCount.set(chatId, 0);
        this.consolidate(chatId).catch(() => {});
      }

      const { tickExchange } = require('./evolve');
      tickExchange(this.userDir).catch(() => {});
    }
  }

  /**
   * Get recent messages for context loading on boot
   */
  async getRecent(chatId, limit = 20) {
    try {
      const res = await fetch(
        `${this.url}/rest/v1/obol_messages?chat_id=eq.${chatId}&user_id=eq.${this.userId}&order=created_at.desc&limit=${limit}&select=role,content,created_at`,
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

      // Ask Haiku to extract memories worth storing long-term
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-20250514',
        max_tokens: 500,
        system: `Analyze this conversation and extract important facts worth remembering long-term.

Return JSON:
{
  "memories": [
    {"content": "concise fact", "category": "fact|preference|decision|lesson|person|project|event|conversation|resource|pattern|context"}
  ]
}

Skip: greetings, small talk, filler. Keep: facts, decisions, preferences, people, projects, events, lessons learned.

Return empty array if nothing worth storing.`,
        messages: [{ role: 'user', content: transcript }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const extracted = JSON.parse(jsonMatch[0]);

      // Store memories to vector store
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

      // Personality files (SOUL.md, USER.md) are only updated by Opus during soul evolution
    } catch {} // Best effort
  }
}

function createMessageLog(supabaseConfig, memory, claudeClient, userId = 0, userDir = null) {
  return new MessageLog(supabaseConfig, memory, claudeClient, userId, userDir);
}

module.exports = { createMessageLog };
