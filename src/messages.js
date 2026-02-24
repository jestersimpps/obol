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
    this._cleanup = setInterval(() => {
      const now = Date.now();
      for (const [key] of this.exchangeCount) {
        if (now - (this._lastActivity?.get(key) || 0) > 1800000) this.exchangeCount.delete(key);
      }
    }, 600000);
    this._cleanup.unref();
    this._lastActivity = new Map();
    this._lastConsolidatedAt = new Map();
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
        }),
      });
    } catch (e) {
      console.error('[messages] Log failed:', e.message);
    }

    // Track exchanges for consolidation + evolution
    if (role === 'assistant') {
      const count = (this.exchangeCount.get(chatId) || 0) + 1;
      this.exchangeCount.set(chatId, count);
      this._lastActivity.set(chatId, Date.now());

      // Consolidate every 5 exchanges
      if (count >= 5) {
        this.exchangeCount.set(chatId, 0);
        this.consolidate(chatId).catch(e => console.error('[consolidate] Failed:', e.message));
      }

      const { checkEvolution } = require('./evolve');
      checkEvolution(this.userDir, this).then(result => {
        if (result?.ready && !this._evolutionReady && !this._evolutionPending) this._evolutionReady = true;
      }).catch(() => {});
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
      const since = this._lastConsolidatedAt.get(chatId);
      this._lastConsolidatedAt.set(chatId, new Date().toISOString());

      let fetchUrl = `${this.url}/rest/v1/obol_messages?chat_id=eq.${chatId}&order=created_at.desc&limit=10&select=role,content,created_at`;
      if (since) fetchUrl += `&created_at=gt.${since}`;
      const msgRes = await fetch(fetchUrl, { headers: this.headers });
      const messages = msgRes.ok ? (await msgRes.json()).reverse() : await this.getRecent(chatId, 10).catch(() => []);
      if (messages.length < 4) return; // Not enough to consolidate

      const transcript = messages.map(m =>
        `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content.substring(0, 500)}`
      ).join('\n');

      // Ask Haiku to extract memories worth storing long-term
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: `Extract ALL noteworthy information from this conversation for long-term memory. Be aggressive — when in doubt, store it.

Return JSON:
{
  "memories": [
    {
      "content": "specific, detailed fact",
      "category": "fact|preference|decision|lesson|person|project|event|conversation|resource|pattern|context",
      "tags": ["tag1", "tag2"],
      "importance": 0.5
    }
  ]
}

STORE generously:
- Personal details (name, age, location, job, relationships, hobbies)
- Preferences and opinions on any topic
- Ongoing projects, goals, tasks, deadlines
- Decisions made and their rationale
- Skills, tools, expertise, tech stack
- Plans, intentions, next steps
- Emotional context (stressed, excited, frustrated)
- Resources mentioned (tools, sites, books, services)
- Events, dates, timelines
- Recurring topics or interests
- Patterns in behavior or communication
- Anything the user would want recalled later

Tags: 2-5 specific lowercase keywords. Examples: ["python", "side-project"], ["health", "sleep"], ["work", "deadline"]

Importance: 0.3 = minor detail, 0.5 = useful context, 0.7 = important, 0.9 = critical to remember

ONLY skip: pure content-free exchanges ("hi", "ok", "thanks", "bye") with zero informational value.

Return empty array only if the entire conversation has no extractable facts.`,
        messages: [{ role: 'user', content: transcript }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/```json?\s*\n?([\s\S]*?)\n?\s*```/) || text.match(/\{[^{}]*"memories"\s*:\s*\[[\s\S]*?\]\s*\}/);
      if (!jsonMatch) return;

      let extracted;
      try {
        extracted = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      } catch {
        return;
      }

      if (extracted.memories?.length && this.memory) {
        const validCategories = new Set(['fact','preference','decision','lesson','person','project','event','conversation','resource','pattern','context','email']);
        for (const mem of extracted.memories) {
          if (!mem.content || mem.content.length <= 10) continue;
          try {
            const existing = await this.memory.search(mem.content, { limit: 1, threshold: 0.92 });
            if (existing.length > 0) continue;
          } catch {}
          const category = validCategories.has(mem.category) ? mem.category : 'fact';
          const tags = Array.isArray(mem.tags) ? mem.tags.slice(0, 5) : [];
          const importance = typeof mem.importance === 'number' ? Math.min(1, Math.max(0, mem.importance)) : 0.5;
          await this.memory.add(mem.content, {
            category,
            tags,
            importance,
            source: 'auto-consolidation',
          });
        }
      }

      // Personality files (SOUL.md, USER.md) are only updated by Opus during soul evolution
    } catch (e) {
      console.error('[consolidate] Failed:', e.message);
    }
  }
}

function createMessageLog(supabaseConfig, memory, claudeClient, userId = 0, userDir = null) {
  return new MessageLog(supabaseConfig, memory, claudeClient, userId, userDir);
}

module.exports = { createMessageLog };
