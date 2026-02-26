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
    it('returns object with log and getRecent methods', () => {
      expect(messageLog).toHaveProperty('log');
      expect(messageLog).toHaveProperty('getRecent');
      expect(typeof messageLog.log).toBe('function');
      expect(typeof messageLog.getRecent).toBe('function');
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
      expect(fetchUrl).toContain('order=created_at.desc');
      expect(fetchUrl).toContain('limit=20');
    });

    it('returns empty array when fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network error'));

      const result = await messageLog.getRecent('chat-1');

      expect(result).toEqual([]);
    });
  });

  describe('fact extraction', () => {
    it('skips extraction when memory is null', async () => {
      const noMemoryLog = createMessageLog(SUPABASE_CONFIG, null, mockClaudeClient, 42);
      mockFetchOk({});
      await noMemoryLog.log('chat-1', 'user', 'hello');
      mockFetchOk({});
      await noMemoryLog.log('chat-1', 'assistant', 'hi there');
      expect(mockMemory.search).not.toHaveBeenCalled();
      expect(mockMemory.add).not.toHaveBeenCalled();
    });
  });
});
