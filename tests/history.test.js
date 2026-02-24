const { describe, it, expect, vi, beforeEach } = globalThis;
const { ChatHistory, parseTurns, validate, repair } = require('../src/history');

describe('parseTurns', () => {
  it('parses simple user/assistant pairs', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'bye' },
      { role: 'assistant', content: 'goodbye' },
    ];
    const turns = parseTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveLength(2);
    expect(turns[1]).toHaveLength(2);
  });

  it('groups tool_use and tool_result into a single turn', () => {
    const messages = [
      { role: 'user', content: 'run something' },
      { role: 'assistant', content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 't1', name: 'exec', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'done' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'finished' }] },
    ];
    const turns = parseTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toHaveLength(4);
  });

  it('groups multi-step tool chains into a single turn', () => {
    const messages = [
      { role: 'user', content: 'do stuff' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'exec', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'step1' },
      ] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't2', name: 'exec', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't2', content: 'step2' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'all done' }] },
    ];
    const turns = parseTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toHaveLength(6);
  });

  it('handles mixed simple and tool turns', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
      { role: 'user', content: 'run this' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'exec', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'welcome' },
    ];
    const turns = parseTurns(messages);
    expect(turns).toHaveLength(3);
    expect(turns[0]).toHaveLength(2);
    expect(turns[1]).toHaveLength(4);
    expect(turns[2]).toHaveLength(2);
  });

  it('handles empty messages', () => {
    expect(parseTurns([])).toHaveLength(0);
  });

  it('handles user message without assistant response', () => {
    const turns = parseTurns([{ role: 'user', content: 'hi' }]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toHaveLength(1);
  });
});

describe('validate', () => {
  it('returns valid for correct alternating history', () => {
    const result = validate([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid for empty history', () => {
    expect(validate([]).valid).toBe(true);
  });

  it('detects first message not user', () => {
    const result = validate([
      { role: 'assistant', content: 'hello' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('first message must be role=user');
  });

  it('detects orphaned tool_result in first message', () => {
    const result = validate([
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'missing', content: 'x' },
      ] },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('orphaned tool_result'))).toBe(true);
  });

  it('detects orphaned tool_result without matching tool_use', () => {
    const result = validate([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'nonexistent', content: 'x' },
      ] },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('orphaned tool_result'))).toBe(true);
  });

  it('detects missing tool_result for tool_use', () => {
    const result = validate([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'exec', input: {} },
      ] },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('missing tool_result'))).toBe(true);
  });

  it('detects consecutive user messages', () => {
    const result = validate([
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'hello' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('consecutive user'))).toBe(true);
  });

  it('allows user tool_result after user message (not flagged as consecutive)', () => {
    const result = validate([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'exec', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'done' },
      ] },
    ]);
    expect(result.valid).toBe(true);
  });
});

describe('repair', () => {
  it('removes orphaned tool_results', () => {
    const messages = [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'orphan', content: 'x' },
      ] },
      { role: 'assistant', content: 'hi' },
    ];
    repair(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
  });

  it('adds missing tool_results', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'exec', input: {} },
      ] },
    ];
    repair(messages);
    expect(messages).toHaveLength(3);
    expect(messages[2].role).toBe('user');
    expect(messages[2].content[0].type).toBe('tool_result');
    expect(messages[2].content[0].tool_use_id).toBe('t1');
  });

  it('merges consecutive user messages', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'there' },
    ];
    repair(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toHaveLength(2);
  });

  it('preserves valid history unchanged', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    repair(messages);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('hi');
    expect(messages[1].content).toBe('hello');
  });
});

describe('ChatHistory', () => {
  let ch;

  beforeEach(() => {
    ch = new ChatHistory(6);
  });

  it('get auto-creates empty array', () => {
    const h = ch.get('test');
    expect(h).toEqual([]);
    expect(ch.has('test')).toBe(true);
  });

  it('pushUser appends user message', () => {
    ch.pushUser('c1', 'hello');
    const h = ch.get('c1');
    expect(h).toHaveLength(1);
    expect(h[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('pushAssistant appends assistant message', () => {
    ch.pushUser('c1', 'hi');
    ch.pushAssistant('c1', 'hello');
    const h = ch.get('c1');
    expect(h).toHaveLength(2);
    expect(h[1]).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('pushMessages bulk appends', () => {
    ch.pushUser('c1', 'hi');
    ch.pushMessages('c1', [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'exec', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]);
    expect(ch.get('c1')).toHaveLength(4);
  });

  it('delete removes a chat', () => {
    ch.pushUser('c1', 'hi');
    ch.delete('c1');
    expect(ch.has('c1')).toBe(false);
  });

  it('clear removes all chats', () => {
    ch.pushUser('c1', 'hi');
    ch.pushUser('c2', 'hey');
    ch.clear();
    expect(ch.has('c1')).toBe(false);
    expect(ch.has('c2')).toBe(false);
  });

  it('inject adds message without validation', () => {
    ch.inject('c1', 'user', 'system message');
    expect(ch.get('c1')).toHaveLength(1);
  });

  describe('prune', () => {
    it('does nothing when under max', () => {
      ch.pushUser('c1', 'hi');
      ch.pushAssistant('c1', 'hello');
      ch.prune('c1');
      expect(ch.get('c1')).toHaveLength(2);
    });

    it('removes oldest turns when over max', () => {
      ch.pushUser('c1', 'msg1');
      ch.pushAssistant('c1', 'reply1');
      ch.pushUser('c1', 'msg2');
      ch.pushAssistant('c1', 'reply2');
      ch.pushUser('c1', 'msg3');
      ch.pushAssistant('c1', 'reply3');
      ch.pushUser('c1', 'msg4');
      ch.pushAssistant('c1', 'reply4');

      ch.prune('c1');
      const h = ch.get('c1');
      expect(h.length).toBeLessThanOrEqual(6);
      expect(h[0].role).toBe('user');
    });

    it('never splits tool turns during pruning', () => {
      const ch2 = new ChatHistory(4);
      ch2.pushUser('c1', 'start');
      ch2.pushAssistant('c1', 'ok');

      ch2.pushUser('c1', 'run tool');
      ch2.pushMessages('c1', [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'exec', input: {} },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'result' },
        ] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ]);

      ch2.prune('c1');
      const h = ch2.get('c1');

      const toolUseIds = new Set();
      const toolResultIds = new Set();
      for (const msg of h) {
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === 'tool_use') toolUseIds.add(b.id);
            if (b.type === 'tool_result') toolResultIds.add(b.tool_use_id);
          }
        }
      }
      for (const id of toolUseIds) {
        expect(toolResultIds.has(id)).toBe(true);
      }
    });

    it('ensures first message is user without tool_result after pruning', () => {
      const ch2 = new ChatHistory(4);
      ch2.pushUser('c1', 'a');
      ch2.pushAssistant('c1', 'b');
      ch2.pushUser('c1', 'c');
      ch2.pushAssistant('c1', 'd');
      ch2.pushUser('c1', 'e');
      ch2.pushAssistant('c1', 'f');

      ch2.prune('c1');
      const h = ch2.get('c1');
      expect(h[0].role).toBe('user');
      if (Array.isArray(h[0].content)) {
        expect(h[0].content.some(b => b.type === 'tool_result')).toBe(false);
      }
    });
  });

  describe('validate', () => {
    it('returns valid for correct history', () => {
      ch.pushUser('c1', 'hi');
      ch.pushAssistant('c1', 'hello');
      expect(ch.validate('c1').valid).toBe(true);
    });
  });

  describe('estimateTokens', () => {
    it('estimates tokens from string content', () => {
      ch.pushUser('c1', 'hello world');
      ch.pushAssistant('c1', 'hi there');
      const stats = ch.estimateTokens('c1', 100);
      expect(stats.messages).toBe(2);
      expect(stats.estimatedTokens).toBeGreaterThan(0);
      expect(stats.maxTokens).toBe(200000);
      expect(stats.pct).toBeGreaterThanOrEqual(0);
    });

    it('estimates tokens from array content with tool_use', () => {
      ch.pushUser('c1', 'run');
      ch.pushMessages('c1', [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'exec', input: { command: 'ls' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file1\nfile2' },
        ] },
        { role: 'assistant', content: [{ type: 'text', text: 'found files' }] },
      ]);
      const stats = ch.estimateTokens('c1', 0);
      expect(stats.estimatedTokens).toBeGreaterThan(0);
    });

    it('returns zero for empty history with no system prompt', () => {
      const stats = ch.estimateTokens('empty', 0);
      expect(stats.messages).toBe(0);
      expect(stats.estimatedTokens).toBe(0);
    });
  });

  describe('auto-repair', () => {
    it('auto-repairs on pushMessages with corrupted data', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      ch.pushUser('c1', 'hi');
      ch.pushMessages('c1', [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'exec', input: {} },
        ] },
      ]);
      const h = ch.get('c1');
      const hasResult = h.some(m =>
        Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
      expect(hasResult).toBe(true);
      spy.mockRestore();
    });
  });
});
