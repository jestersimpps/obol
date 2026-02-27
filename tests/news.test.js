const { describe, it, expect, vi, beforeEach } = globalThis;

const { runProactiveNews } = require('../src/curiosity/news');

function makeClient(responses) {
  let callIdx = 0;
  return {
    messages: {
      create: vi.fn(async () => responses[Math.min(callIdx++, responses.length - 1)]),
    },
  };
}

function makeMemory(results = []) {
  return {
    search: vi.fn().mockResolvedValue(results),
  };
}

describe('news', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when model ends without composing', async () => {
    const client = makeClient([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nothing interesting today' }] },
    ]);

    const result = await runProactiveNews(client, ['ai'], null, {}, 'UTC');

    expect(result).toEqual([]);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('composes messages from tool calls', async () => {
    const client = makeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'AI news today' } },
        ],
      },
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't2', name: 'search_user_memory', input: { query: 'AI projects' } },
        ],
      },
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use', id: 't3', name: 'compose_news_message',
            input: { message: 'Hey, OpenAI just dropped something wild', confidence: 0.8, topic: 'ai' },
          },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] },
    ]);

    const memory = makeMemory([{ content: 'User works on AI projects' }]);
    const result = await runProactiveNews(client, ['ai'], memory, {}, 'America/New_York');

    expect(result).toEqual(['Hey, OpenAI just dropped something wild']);
    expect(memory.search).toHaveBeenCalledWith('AI projects', { limit: 5, threshold: 0.3 });
  });

  it('rejects low-confidence messages', async () => {
    const client = makeClient([
      {
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use', id: 't1', name: 'compose_news_message',
          input: { message: 'Something boring', confidence: 0.3, topic: 'news' },
        }],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] },
    ]);

    const result = await runProactiveNews(client, ['news'], null, {}, 'UTC');
    expect(result).toEqual([]);
  });

  it('caps at 3 messages', async () => {
    const responses = [];
    for (let i = 0; i < 4; i++) {
      responses.push({
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use', id: `t${i}`, name: 'compose_news_message',
          input: { message: `Message ${i}`, confidence: 0.9, topic: 'test' },
        }],
      });
    }
    responses.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] });

    const client = makeClient(responses);
    const result = await runProactiveNews(client, ['test'], null, {}, 'UTC');

    expect(result).toHaveLength(3);
  });

  it('passes topics and personality to system prompt', async () => {
    const client = makeClient([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nothing' }] },
    ]);

    const personality = { soul: 'Curious and playful', user: 'Loves sailing' };
    await runProactiveNews(client, ['sailing', 'crypto'], null, personality, 'Europe/Amsterdam');

    const systemArg = client.messages.create.mock.calls[0][0].system;
    expect(systemArg).toContain('sailing, crypto');
    expect(systemArg).toContain('Curious and playful');
    expect(systemArg).toContain('Loves sailing');
    expect(systemArg).toContain('Europe/Amsterdam');
  });

  it('includes web_search as server-side tool', async () => {
    const client = makeClient([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] },
    ]);

    await runProactiveNews(client, ['ai'], null, {}, 'UTC');

    const tools = client.messages.create.mock.calls[0][0].tools;
    const webSearch = tools.find(t => t.name === 'web_search');
    expect(webSearch).toBeDefined();
    expect(webSearch.type).toBe('web_search_20250305');
  });

  it('handles memory search errors gracefully', async () => {
    const client = makeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't1', name: 'search_user_memory', input: { query: 'test' } },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] },
    ]);

    const memory = { search: vi.fn().mockRejectedValue(new Error('DB down')) };
    const result = await runProactiveNews(client, ['test'], memory, {}, 'UTC');

    expect(result).toEqual([]);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it('works without memory (null)', async () => {
    const client = makeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't1', name: 'search_user_memory', input: { query: 'test' } },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] },
    ]);

    const result = await runProactiveNews(client, ['test'], null, {}, 'UTC');
    expect(result).toEqual([]);
  });

  it('respects max iterations limit', async () => {
    const client = makeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't1', name: 'search_user_memory', input: { query: 'loop' } },
        ],
      },
    ]);

    const result = await runProactiveNews(client, ['test'], makeMemory(), {}, 'UTC');

    expect(client.messages.create).toHaveBeenCalledTimes(12);
    expect(result).toEqual([]);
  });
});
