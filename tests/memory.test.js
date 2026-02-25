const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;

const mockEmbedderFn = vi.fn(() => Promise.resolve({ data: new Float32Array(384).fill(0.1) }));
const mockPipeline = vi.fn(() => Promise.resolve(mockEmbedderFn));

const transformersPath = require.resolve('@xenova/transformers');
require.cache[transformersPath] = {
  id: transformersPath,
  filename: transformersPath,
  loaded: true,
  exports: { pipeline: mockPipeline },
};

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { createMemory, getEmbedding } = require('../src/memory');

const SUPABASE_CONFIG = {
  url: 'https://test.supabase.co',
  serviceKey: 'test-service-key',
};

function mockFetchOk(data) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function mockFetchError(data) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    json: () => Promise.resolve(data),
  });
}

describe('memory', () => {
  let memory;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEmbedderFn.mockImplementation(() => Promise.resolve({ data: new Float32Array(384).fill(0.1) }));
    mockPipeline.mockImplementation(() => Promise.resolve(mockEmbedderFn));
    memory = await createMemory(SUPABASE_CONFIG, 42);
  });

  describe('createMemory', () => {
    it('returns object with expected methods', () => {
      expect(memory).toHaveProperty('add');
      expect(memory).toHaveProperty('search');
      expect(memory).toHaveProperty('byDate');
      expect(memory).toHaveProperty('recent');
      expect(memory).toHaveProperty('update');
      expect(memory).toHaveProperty('forget');
      expect(memory).toHaveProperty('stats');
    });
  });

  describe('add', () => {
    it('calls fetch with POST to /rest/v1/obol_memory with correct body', async () => {
      const returnedRecord = { id: 1, content: 'test fact' };
      mockFetchOk([returnedRecord]);

      const result = await memory.add('test fact', {
        category: 'fact',
        importance: 0.8,
        source: 'test',
        tags: ['a', 'b'],
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toBe('https://test.supabase.co/rest/v1/obol_memory');
      expect(fetchOpts.method).toBe('POST');

      const body = JSON.parse(fetchOpts.body);
      expect(body.content).toBe('test fact');
      expect(body.category).toBe('fact');
      expect(body.importance).toBe(0.8);
      expect(body.source).toBe('test');
      expect(body.tags).toEqual(['a', 'b']);
      expect(body.embedding).toHaveLength(384);
      expect(body.user_id).toBe(42);
      expect(result).toEqual(returnedRecord);
    });

    it('uses default values for optional opts', async () => {
      mockFetchOk([{ id: 2 }]);

      await memory.add('bare fact');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.category).toBe('fact');
      expect(body.importance).toBe(0.5);
      expect(body.source).toBeNull();
      expect(body.tags).toEqual([]);
    });

    it('throws on non-ok response', async () => {
      mockFetchError({ message: 'insert failed' });
      await expect(memory.add('bad')).rejects.toThrow('insert failed');
    });
  });

  describe('search', () => {
    it('calls fetch with POST to /rest/v1/rpc/match_obol_memories', async () => {
      mockFetchOk([{ id: 1, content: 'match', similarity: 0.9 }]);
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      const results = await memory.search('find this', { limit: 5, threshold: 0.5, category: 'fact' });

      const [searchUrl, searchOpts] = mockFetch.mock.calls[0];
      expect(searchUrl).toBe('https://test.supabase.co/rest/v1/rpc/match_obol_memories');
      expect(searchOpts.method).toBe('POST');

      const body = JSON.parse(searchOpts.body);
      expect(body.query_embedding).toHaveLength(384);
      expect(body.match_threshold).toBe(0.5);
      expect(body.match_count).toBe(5);
      expect(body.filter_category).toBe('fact');
      expect(body.filter_user_id).toBe(42);
      expect(results).toHaveLength(1);
    });

    it('increments access count for returned results', async () => {
      mockFetchOk([{ id: 10 }, { id: 20 }]);
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      await memory.search('query');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [rpcUrl, rpcOpts] = mockFetch.mock.calls[1];
      expect(rpcUrl).toContain('/rest/v1/rpc/increment_memory_access');
      expect(rpcOpts.method).toBe('POST');
      const body = JSON.parse(rpcOpts.body);
      expect(body.memory_ids).toEqual([10, 20]);
    });

    it('skips accessed_at update when no results', async () => {
      mockFetchOk([]);

      await memory.search('nothing');

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('byDate', () => {
    it('byDate("today") calls fetch with today date range params', async () => {
      mockFetchOk([]);

      await memory.byDate('today');

      const fetchUrl = mockFetch.mock.calls[0][0];
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayEnd = new Date(todayStart);
      todayEnd.setDate(todayEnd.getDate() + 1);

      expect(fetchUrl).toContain(`created_at=gte.${todayStart.toISOString()}`);
      expect(fetchUrl).toContain(`created_at=lt.${todayEnd.toISOString()}`);
      expect(fetchUrl).toContain('user_id=eq.42');
    });

    it('byDate("yesterday") calls fetch with yesterday date range', async () => {
      mockFetchOk([]);

      await memory.byDate('yesterday');

      const fetchUrl = mockFetch.mock.calls[0][0];
      const now = new Date();
      const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const yesterdayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      expect(fetchUrl).toContain(`created_at=gte.${yesterdayStart.toISOString()}`);
      expect(fetchUrl).toContain(`created_at=lt.${yesterdayEnd.toISOString()}`);
    });

    it('byDate("7d") calls fetch with 7 days range', async () => {
      mockFetchOk([]);

      await memory.byDate('7d');

      const fetchUrl = mockFetch.mock.calls[0][0];
      const now = new Date();
      const sevenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

      expect(fetchUrl).toContain(`created_at=gte.${sevenDaysAgo.toISOString()}`);
      expect(fetchUrl).toContain(`created_at=lt.${tomorrow.toISOString()}`);
    });

    it('byDate with invalid date throws error', async () => {
      await expect(memory.byDate('not-a-date')).rejects.toThrow('Cannot parse date: not-a-date');
    });
  });

  describe('forget', () => {
    it('calls DELETE with correct URL', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await memory.forget(99);

      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toBe('https://test.supabase.co/rest/v1/obol_memory?id=eq.99');
      expect(fetchOpts.method).toBe('DELETE');
      expect(fetchOpts.headers['Prefer']).toBe('return=minimal');
    });
  });

  describe('stats', () => {
    it('returns total, counts, and breakdown', async () => {
      mockFetchOk([
        { category: 'fact' },
        { category: 'fact' },
        { category: 'preference' },
        { category: 'fact' },
      ]);

      const result = await memory.stats();

      expect(result.total).toBe(4);
      expect(result.counts).toEqual({ fact: 3, preference: 1 });
      expect(result.breakdown).toContain('fact: 3');
      expect(result.breakdown).toContain('preference: 1');
    });

    it('returns zero total for empty data', async () => {
      mockFetchOk([]);

      const result = await memory.stats();

      expect(result.total).toBe(0);
      expect(result.counts).toEqual({});
      expect(result.breakdown).toBe('');
    });
  });

  describe('getEmbedding', () => {
    it('returns array of numbers with length 384', async () => {
      const embedding = await getEmbedding('hello world');

      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding).toHaveLength(384);
      embedding.forEach(val => expect(typeof val).toBe('number'));
    });
  });
});
