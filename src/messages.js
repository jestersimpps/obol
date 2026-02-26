/**
 * Message logging + per-turn fact extraction to vector memory.
 *
 * Tier 1: obol_messages — raw log, every message
 * Tier 2: obol_memory — curated facts, extracted after every assistant turn
 * Tier 3: obol_events — follow-up intents, detected by batch analysis (see analysis.js)
 * Tier 4: obol_user_patterns — synthesized behavioral patterns, refreshed by batch analysis (see analysis.js)
 */

const Anthropic = require('@anthropic-ai/sdk');

class MessageLog {
  constructor(supabaseConfig, memory, anthropicConfig, userId = 0, userDir = null) {
    this.url = supabaseConfig.url;
    this.headers = {
      'apikey': supabaseConfig.serviceKey,
      'Authorization': `Bearer ${supabaseConfig.serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    };
    this.memory = memory;
    this._anthropicConfig = anthropicConfig;
    this._extractionClient = null;
    this.userId = userId;
    this.userDir = userDir;
    this.exchangeCount = new Map();
    this._lastUserMessage = new Map();
    this._verboseCallbacks = new Map();
    this._cleanup = setInterval(() => {
      const now = Date.now();
      for (const [key] of this.exchangeCount) {
        if (now - (this._lastActivity?.get(key) || 0) > 1800000) {
          this.exchangeCount.delete(key);
          this._lastUserMessage.delete(key);
          this._verboseCallbacks.delete(key);
        }
      }
    }, 600000);
    this._cleanup.unref();
    this._lastActivity = new Map();
  }

  async log(chatId, role, content, opts = {}) {
    const truncated = content.substring(0, 50000);

    try {
      await fetch(`${this.url}/rest/v1/obol_messages`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          chat_id: chatId,
          role,
          content: truncated,
          model: opts.model || null,
          tokens_in: opts.tokensIn || null,
          tokens_out: opts.tokensOut || null,
        }),
      });
    } catch (e) {
      console.error('[messages] Log failed:', e.message);
    }

    if (role === 'user') {
      this._lastUserMessage.set(chatId, truncated);
    }

    if (role === 'assistant') {
      const count = (this.exchangeCount.get(chatId) || 0) + 1;
      this.exchangeCount.set(chatId, count);
      this._lastActivity.set(chatId, Date.now());

      const lastUser = this._lastUserMessage.get(chatId);
      if (lastUser) {
        this._extractFacts(chatId, lastUser, truncated).catch(() => {});
      }
    }
  }

  async getRecent(chatId, limit = 50) {
    try {
      const res = await fetch(
        `${this.url}/rest/v1/obol_messages?chat_id=eq.${chatId}&order=created_at.desc&limit=${limit}&select=role,content,created_at`,
        { headers: this.headers }
      );
      const data = await res.json();
      const rows = data.reverse();
      const firstUserIdx = rows.findIndex(r => r.role === 'user');
      return firstUserIdx > 0 ? rows.slice(firstUserIdx) : rows;
    } catch {
      return [];
    }
  }

  async getSince(chatId, since, limit = 500) {
    try {
      const res = await fetch(
        `${this.url}/rest/v1/obol_messages?chat_id=eq.${chatId}&created_at=gte.${since.toISOString()}&order=created_at.asc&limit=${limit}&select=role,content,created_at`,
        { headers: this.headers }
      );
      const data = await res.json();
      if (!res.ok) return [];
      return data;
    } catch {
      return [];
    }
  }

  async getByDate(chatId, dateStr, opts = {}) {
    const { start, end } = parseDateRange(dateStr);
    const limit = opts.limit || 50;
    let fetchUrl = `${this.url}/rest/v1/obol_messages?chat_id=eq.${chatId}&created_at=gte.${start.toISOString()}&created_at=lt.${end.toISOString()}&order=created_at.asc&limit=${limit}&select=role,content,created_at`;
    if (opts.role) fetchUrl += `&role=eq.${opts.role}`;
    const res = await fetch(fetchUrl, { headers: this.headers });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  }

  _getExtractionClient() {
    if (!this._extractionClient && this._anthropicConfig) {
      const key = this._anthropicConfig.apiKey;
      const oauth = this._anthropicConfig.oauth;
      if (oauth?.accessToken) {
        this._extractionClient = new Anthropic({
          apiKey: null,
          authToken: oauth.accessToken,
          defaultHeaders: {
            'anthropic-dangerous-direct-browser-access': 'true',
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
          },
        });
      } else if (key) {
        this._extractionClient = new Anthropic({ apiKey: key });
      }
    }
    return this._extractionClient;
  }

  async _extractFacts(chatId, userMsg, assistantMsg) {
    if (!this.memory) return;
    const client = this._getExtractionClient();
    if (!client) return;
    const vlog = this._verboseCallbacks.get(chatId);

    const extractTool = [{
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
                category: { type: 'string', enum: ['fact','preference','decision','lesson','person','project','event','conversation','resource','pattern','context','email'] },
                importance: { type: 'number' },
                tags: { type: 'array', items: { type: 'string' } },
              },
              required: ['content', 'category', 'importance'],
            },
          },
        },
        required: ['facts'],
      },
    }];

    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `Extract facts from this exchange.

FACTS (0-5 atomic facts worth remembering long-term):
Store: personal details, preferences, decisions, projects, plans, people mentioned, technical details, events, deadlines, emotional context, resources.
Skip: greetings, acknowledgments, content-free exchanges.
Importance: 0.3 minor, 0.5 useful, 0.7 important, 0.9 critical.`,
        tools: extractTool,
        tool_choice: { type: 'tool', name: 'save_memory' },
        messages: [{ role: 'user', content: `Human: ${userMsg.substring(0, 2000)}\nAssistant: ${assistantMsg.substring(0, 2000)}` }],
      });

      const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'save_memory');
      if (!toolUse) return;

      const facts = toolUse.input?.facts;

      if (Array.isArray(facts) && facts.length > 0) {
        const validCategories = new Set(['fact','preference','decision','lesson','person','project','event','conversation','resource','pattern','context','email']);
        let stored = 0;
        let duped = 0;

        for (const fact of facts.slice(0, 5)) {
          if (!fact.content || fact.content.length <= 10) continue;
          try {
            const existing = await this.memory.search(fact.content, { limit: 1, threshold: 0.92 });
            if (existing.length > 0) { duped++; continue; }
          } catch {}
          const category = validCategories.has(fact.category) ? fact.category : 'fact';
          const importance = typeof fact.importance === 'number' ? Math.min(1, Math.max(0, fact.importance)) : 0.5;
          const tags = Array.isArray(fact.tags) ? fact.tags.slice(0, 5) : [];
          await this.memory.add(fact.content, { category, tags, importance, source: 'turn-extraction' });
          stored++;
          vlog?.(`[extract] +[${category}] ${fact.content}`);
        }

        if (stored > 0 || duped > 0) {
          vlog?.(`[extract] ${stored} stored, ${duped} duped, ${facts.length} extracted`);
        }
      } else {
        vlog?.('[extract] 0 facts (trivial exchange)');
      }
    } catch (e) {
      console.error('[extract] Failed:', e.message);
      vlog?.(`[extract] ERROR: ${e.message}`);
    }
  }
}

function createMessageLog(supabaseConfig, memory, anthropicConfig, userId = 0, userDir = null) {
  return new MessageLog(supabaseConfig, memory, anthropicConfig, userId, userDir);
}

function parseDateRange(dateStr) {
  const now = new Date();
  let start, end;

  if (!dateStr || dateStr === 'today') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(start); end.setDate(end.getDate() + 1);
  } else if (dateStr === 'yesterday') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (/^(\d+)d$/.test(dateStr)) {
    const days = parseInt(dateStr);
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  } else {
    const parsed = new Date(dateStr);
    if (isNaN(parsed)) throw new Error(`Cannot parse date: ${dateStr}`);
    start = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    end = new Date(start); end.setDate(end.getDate() + 1);
  }

  return { start, end };
}

module.exports = { createMessageLog };
