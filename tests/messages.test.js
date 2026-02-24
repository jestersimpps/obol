const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('../src/config', () => ({
  OBOL_DIR: '/mock/.obol',
}));

const mockCheckEvolution = vi.fn(() => Promise.resolve({ ready: false }));
const evolvePath = require.resolve('../src/evolve');
require.cache[evolvePath] = {
  id: evolvePath,
  filename: evolvePath,
  loaded: true,
  exports: { checkEvolution: mockCheckEvolution },
};

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { createMessageLog } = require('../src/messages');

const SUPABASE_CONFIG = {
  url: 'https://test.supabase.co',
  serviceKey: 'test-service-key',
};

const mockMemory = {
  add: vi.fn(),
  search: vi.fn(),
};

const mockClaudeClient = {
  messages: {
    create: vi.fn(),
  },
};

function mockFetchOk(data) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

describe('messages', () => {
  let messageLog;

  beforeEach(() => {
    vi.clearAllMocks();
    messageLog = createMessageLog(SUPABASE_CONFIG, mockMemory, mockClaudeClient, 42, '/mock/userdir');
  });

  describe('createMessageLog', () => {
    it('returns object with log, getRecent, consolidate methods', () => {
      expect(messageLog).toHaveProperty('log');
      expect(messageLog).toHaveProperty('getRecent');
      expect(messageLog).toHaveProperty('consolidate');
      expect(typeof messageLog.log).toBe('function');
      expect(typeof messageLog.getRecent).toBe('function');
      expect(typeof messageLog.consolidate).toBe('function');
    });
  });

  describe('log', () => {
    it('sends POST with correct body including truncated content', async () => {
      mockFetchOk({});

      const longContent = 'x'.repeat(60000);
      await messageLog.log('chat-1', 'user', longContent, {
        model: 'claude-3',
        tokensIn: 100,
        tokensOut: 200,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toBe('https://test.supabase.co/rest/v1/obol_messages');
      expect(fetchOpts.method).toBe('POST');

      const body = JSON.parse(fetchOpts.body);
      expect(body.chat_id).toBe('chat-1');
      expect(body.role).toBe('user');
      expect(body.content).toHaveLength(50000);
      expect(body.model).toBe('claude-3');
      expect(body.tokens_in).toBe(100);
      expect(body.tokens_out).toBe(200);
      expect(body.user_id).toBe(42);
    });

    it('checks evolution on assistant messages', async () => {
      mockFetchOk({});
      await messageLog.log('chat-1', 'assistant', 'response 1');

      mockFetchOk({});
      await messageLog.log('chat-1', 'assistant', 'response 2');

      expect(mockCheckEvolution).toHaveBeenCalledTimes(2);
    });

    it('does not check evolution on user messages', async () => {
      mockFetchOk({});
      await messageLog.log('chat-1', 'user', 'hello');

      expect(mockCheckEvolution).not.toHaveBeenCalled();
    });

    it('triggers consolidation after 10 assistant messages', async () => {
      const consolidateSpy = vi.spyOn(messageLog, 'consolidate').mockResolvedValue(undefined);

      for (let i = 0; i < 10; i++) {
        mockFetchOk({});
        await messageLog.log('chat-1', 'assistant', `response ${i}`);
      }

      expect(consolidateSpy).toHaveBeenCalledWith('chat-1');
      consolidateSpy.mockRestore();
    });

    it('does not throw when fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network error'));

      await expect(messageLog.log('chat-1', 'user', 'hello')).resolves.toBeUndefined();
    });
  });

  describe('getRecent', () => {
    it('returns messages in reverse order (oldest first)', async () => {
      const messages = [
        { role: 'assistant', content: 'newest', created_at: '2026-01-03T00:00:00Z' },
        { role: 'user', content: 'middle', created_at: '2026-01-02T00:00:00Z' },
        { role: 'user', content: 'oldest', created_at: '2026-01-01T00:00:00Z' },
      ];
      mockFetchOk(messages);

      const result = await messageLog.getRecent('chat-1', 20);

      expect(result[0].content).toBe('oldest');
      expect(result[1].content).toBe('middle');
      expect(result[2].content).toBe('newest');

      const fetchUrl = mockFetch.mock.calls[0][0];
      expect(fetchUrl).toContain('chat_id=eq.chat-1');
      expect(fetchUrl).toContain('user_id=eq.42');
      expect(fetchUrl).toContain('order=created_at.desc');
      expect(fetchUrl).toContain('limit=20');
    });

    it('returns empty array when fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network error'));

      const result = await messageLog.getRecent('chat-1');

      expect(result).toEqual([]);
    });
  });

  describe('consolidate', () => {
    it('skips when memory is null', async () => {
      const noMemoryLog = createMessageLog(SUPABASE_CONFIG, null, mockClaudeClient, 42);
      await noMemoryLog.consolidate('chat-1');
      expect(mockClaudeClient.messages.create).not.toHaveBeenCalled();
    });

    it('skips when client is null', async () => {
      const noClientLog = createMessageLog(SUPABASE_CONFIG, mockMemory, null, 42);
      await noClientLog.consolidate('chat-1');
      expect(mockMemory.search).not.toHaveBeenCalled();
    });

    it('skips when fewer than 4 messages', async () => {
      mockFetchOk([
        { role: 'user', content: 'hi', created_at: '2026-01-01T00:00:00Z' },
        { role: 'assistant', content: 'hello', created_at: '2026-01-01T00:00:01Z' },
      ]);

      await messageLog.consolidate('chat-1');

      expect(mockClaudeClient.messages.create).not.toHaveBeenCalled();
    });

    it('extracts memories and stores deduplicated facts', async () => {
      const messages = [
        { role: 'user', content: 'msg1', created_at: '2026-01-01T00:00:00Z' },
        { role: 'assistant', content: 'msg2', created_at: '2026-01-01T00:00:01Z' },
        { role: 'user', content: 'msg3', created_at: '2026-01-01T00:00:02Z' },
        { role: 'assistant', content: 'msg4', created_at: '2026-01-01T00:00:03Z' },
      ];
      mockFetchOk(messages);

      mockClaudeClient.messages.create.mockResolvedValueOnce({
        content: [{ text: '{"memories": [{"content": "user likes TypeScript", "category": "preference"}]}' }],
      });

      mockMemory.search.mockResolvedValueOnce([]);
      mockMemory.add.mockResolvedValueOnce({});

      await messageLog.consolidate('chat-1');

      expect(mockMemory.search).toHaveBeenCalledWith('user likes TypeScript', { limit: 1, threshold: 0.85 });
      expect(mockMemory.add).toHaveBeenCalledWith('user likes TypeScript', {
        category: 'preference',
        importance: 0.5,
        source: 'auto-consolidation',
      });
    });

    it('skips duplicate memories', async () => {
      const messages = [
        { role: 'user', content: 'msg1', created_at: '2026-01-01T00:00:00Z' },
        { role: 'assistant', content: 'msg2', created_at: '2026-01-01T00:00:01Z' },
        { role: 'user', content: 'msg3', created_at: '2026-01-01T00:00:02Z' },
        { role: 'assistant', content: 'msg4', created_at: '2026-01-01T00:00:03Z' },
      ];
      mockFetchOk(messages);

      mockClaudeClient.messages.create.mockResolvedValueOnce({
        content: [{ text: '{"memories": [{"content": "already known fact", "category": "fact"}]}' }],
      });

      mockMemory.search.mockResolvedValueOnce([{ id: 1, content: 'already known fact' }]);

      await messageLog.consolidate('chat-1');

      expect(mockMemory.add).not.toHaveBeenCalled();
    });
  });
});
