const { describe, it, expect, vi, beforeEach } = globalThis;

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

const { createSelfMemory } = require('../src/memory-self');

const SUPABASE_CONFIG = {
  url: 'https://test.supabase.co',
  serviceKey: 'test-service-key',
};

function mockFetchOk(data) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  });
}

function mockFetchError(data) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 400,
    json: () => Promise.resolve(data),
  });
}

describe('memory-self', () => {
  let selfMemory;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEmbedderFn.mockImplementation(() => Promise.resolve({ data: new Float32Array(384).fill(0.1) }));
    mockPipeline.mockImplementation(() => Promise.resolve(mockEmbedderFn));
    selfMemory = await createSelfMemory(SUPABASE_CONFIG, 0);
  });

  describe('createSelfMemory', () => {
    it('returns object with expected methods', () => {
      expect(selfMemory).toHaveProperty('add');
      expect(selfMemory).toHaveProperty('search');
      expect(selfMemory).toHaveProperty('recent');
      expect(selfMemory).toHaveProperty('query');
      expect(selfMemory).toHaveProperty('update');
      expect(selfMemory).toHaveProperty('forget');
    });
  });

  describe('add', () => {
    it('calls fetch with POST to /rest/v1/obol_self_memory with correct body', async () => {
      mockFetchOk([{ id: 1, content: 'test finding' }]);

      const result = await selfMemory.add('test finding', {
        category: 'research',
        importance: 0.8,
        source: 'curiosity',
        tags: ['science'],
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toBe('https://test.supabase.co/rest/v1/obol_self_memory');
      expect(fetchOpts.method).toBe('POST');

      const body = JSON.parse(fetchOpts.body);
      expect(body.content).toBe('test finding');
      expect(body.category).toBe('research');
      expect(body.importance).toBe(0.8);
      expect(body.source).toBe('curiosity');
      expect(body.tags).toEqual(['science']);
      expect(body.embedding).toHaveLength(384);
      expect(body.user_id).toBe(0);
      expect(result).toEqual({ id: 1, content: 'test finding' });
    });

    it('uses default values for optional opts', async () => {
      mockFetchOk([{ id: 2 }]);

      await selfMemory.add('bare finding');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.category).toBe('research');
      expect(body.importance).toBe(0.5);
      expect(body.source).toBeNull();
      expect(body.tags).toEqual([]);
    });

    it('coerces invalid category to research', async () => {
      mockFetchOk([{ id: 3 }]);

      await selfMemory.add('something', { category: 'invalid-category' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.category).toBe('research');
    });

    it('accepts all valid categories', async () => {
      for (const category of ['research', 'interest', 'self', 'pattern']) {
        vi.clearAllMocks();
        mockFetchOk([{ id: 1 }]);
        await selfMemory.add('content', { category });
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.category).toBe(category);
      }
    });

    it('throws on non-ok response', async () => {
      mockFetchError({ message: 'insert failed' });
      await expect(selfMemory.add('bad')).rejects.toThrow('insert failed');
    });
  });

  describe('recent', () => {
    it('calls fetch with correct URL and default limit', async () => {
      mockFetchOk([]);

      await selfMemory.recent();

      const fetchUrl = mockFetch.mock.calls[0][0];
      expect(fetchUrl).toContain('/rest/v1/obol_self_memory');
      expect(fetchUrl).toContain('limit=10');
      expect(fetchUrl).toContain('user_id=eq.0');
      expect(fetchUrl).toContain('order=created_at.desc');
    });

    it('applies custom limit', async () => {
      mockFetchOk([]);

      await selfMemory.recent({ limit: 5 });

      expect(mockFetch.mock.calls[0][0]).toContain('limit=5');
    });

    it('filters by category when provided', async () => {
      mockFetchOk([]);

      await selfMemory.recent({ category: 'interest' });

      expect(mockFetch.mock.calls[0][0]).toContain('category=eq.interest');
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(selfMemory.recent()).rejects.toThrow('Self memory recent failed');
    });
  });

  describe('search', () => {
    it('calls RPC with correct params', async () => {
      mockFetchOk([{ id: 1, content: 'result', similarity: 0.9 }]);
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      const results = await selfMemory.search('find this', { limit: 5, threshold: 0.5, category: 'research' });

      const [searchUrl, searchOpts] = mockFetch.mock.calls[0];
      expect(searchUrl).toBe('https://test.supabase.co/rest/v1/rpc/match_obol_self_memories');
      expect(searchOpts.method).toBe('POST');

      const body = JSON.parse(searchOpts.body);
      expect(body.query_embedding).toHaveLength(384);
      expect(body.match_threshold).toBe(0.5);
      expect(body.match_count).toBe(5);
      expect(body.filter_category).toBe('research');
      expect(body.filter_user_id).toBe(0);
      expect(results).toHaveLength(1);
    });

    it('increments access count for returned results', async () => {
      mockFetchOk([{ id: 10 }, { id: 20 }]);
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      await selfMemory.search('query');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [rpcUrl, rpcOpts] = mockFetch.mock.calls[1];
      expect(rpcUrl).toContain('/rest/v1/rpc/increment_self_memory_access');
      expect(rpcOpts.method).toBe('POST');
      expect(JSON.parse(rpcOpts.body).memory_ids).toEqual([10, 20]);
    });

    it('skips access increment when no results', async () => {
      mockFetchOk([]);

      await selfMemory.search('nothing');

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws on non-ok response', async () => {
      mockFetchError({ message: 'rpc failed' });
      await expect(selfMemory.search('query')).rejects.toThrow('rpc failed');
    });
  });

  describe('query', () => {
    it('calls fetch with user_id filter by default', async () => {
      mockFetchOk([]);

      await selfMemory.query();

      const fetchUrl = mockFetch.mock.calls[0][0];
      expect(fetchUrl).toContain('user_id=eq.0');
      expect(fetchUrl).toContain('limit=20');
    });

    it('applies minImportance filter', async () => {
      mockFetchOk([]);

      await selfMemory.query({ minImportance: 0.7 });

      expect(mockFetch.mock.calls[0][0]).toContain('importance=gte.0.7');
    });

    it('applies category filter', async () => {
      mockFetchOk([]);

      await selfMemory.query({ category: 'self' });

      expect(mockFetch.mock.calls[0][0]).toContain('category=eq.self');
    });

    it('applies source filter', async () => {
      mockFetchOk([]);

      await selfMemory.query({ source: 'curiosity' });

      expect(mockFetch.mock.calls[0][0]).toContain('source=eq.curiosity');
    });

    it('applies tags filter', async () => {
      mockFetchOk([]);

      await selfMemory.query({ tags: ['a', 'b'] });

      expect(mockFetch.mock.calls[0][0]).toContain('tags=ov.{a,b}');
    });

    it('throws on non-ok response', async () => {
      mockFetchError({ message: 'query failed' });
      await expect(selfMemory.query()).rejects.toThrow('query failed');
    });
  });

  describe('update', () => {
    it('patches content and regenerates embedding', async () => {
      mockFetchOk([{ id: 1, content: 'updated' }]);

      await selfMemory.update(1, { content: 'updated content' });

      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toBe('https://test.supabase.co/rest/v1/obol_self_memory?id=eq.1');
      expect(fetchOpts.method).toBe('PATCH');

      const body = JSON.parse(fetchOpts.body);
      expect(body.content).toBe('updated content');
      expect(body.embedding).toHaveLength(384);
    });

    it('patches importance without regenerating embedding', async () => {
      mockFetchOk([{ id: 1 }]);

      await selfMemory.update(1, { importance: 0.9 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.importance).toBe(0.9);
      expect(body.embedding).toBeUndefined();
    });

    it('skips invalid category', async () => {
      mockFetchOk([{ id: 1 }]);

      await selfMemory.update(1, { category: 'invalid' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.category).toBeUndefined();
    });

    it('accepts valid category', async () => {
      mockFetchOk([{ id: 1 }]);

      await selfMemory.update(1, { category: 'interest' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.category).toBe('interest');
    });

    it('throws on non-ok response', async () => {
      mockFetchError({ message: 'update failed' });
      await expect(selfMemory.update(1, { importance: 0.5 })).rejects.toThrow('update failed');
    });
  });

  describe('forget', () => {
    it('calls DELETE with correct URL', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await selfMemory.forget(42);

      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toBe('https://test.supabase.co/rest/v1/obol_self_memory?id=eq.42');
      expect(fetchOpts.method).toBe('DELETE');
      expect(fetchOpts.headers['Prefer']).toBe('return=minimal');
    });
  });
});
