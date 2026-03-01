const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;
const fs = require('fs');

const { backup, restore, restoreIfMissing, PERSONALITY_DIR } = require('../src/soul');

const supabaseConfig = {
  url: 'https://test.supabase.co',
  serviceKey: 'test-service-key',
};

describe('soul', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('backup', () => {
    it('POSTs content to obol_soul table', async () => {
      fetch.mockResolvedValue({ ok: true });

      await backup(supabaseConfig, 'soul', '# My Soul');

      expect(fetch).toHaveBeenCalledWith(
        'https://test.supabase.co/rest/v1/obol_soul',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"# My Soul"'),
        })
      );
    });

    it('includes the key as id in the body', async () => {
      fetch.mockResolvedValue({ ok: true });

      await backup(supabaseConfig, 'soul', 'content');

      const body = JSON.parse(fetch.mock.calls[0][1].body);
      expect(body.id).toBe('soul');
      expect(body.content).toBe('content');
    });

    it('uses return=minimal prefer header', async () => {
      fetch.mockResolvedValue({ ok: true });

      await backup(supabaseConfig, 'soul', 'content');

      const headers = fetch.mock.calls[0][1].headers;
      expect(headers['Prefer']).toBe('return=minimal');
    });

    it('does nothing when supabaseConfig is missing url', async () => {
      await backup({ serviceKey: 'key' }, 'soul', 'content');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('does nothing when supabaseConfig is missing serviceKey', async () => {
      await backup({ url: 'https://test.supabase.co' }, 'soul', 'content');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('does nothing when supabaseConfig is null', async () => {
      await backup(null, 'soul', 'content');
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    it('returns content from Supabase when found', async () => {
      fetch.mockResolvedValue({
        ok: true,
        json: async () => [{ content: '# Soul content' }],
      });

      const result = await restore(supabaseConfig);

      expect(result).toBe('# Soul content');
    });

    it('queries the correct endpoint with like filter', async () => {
      fetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      await restore(supabaseConfig);

      expect(fetch).toHaveBeenCalledWith(
        'https://test.supabase.co/rest/v1/obol_soul?id=like.soul%25&order=updated_at.desc&limit=1&select=content',
        expect.any(Object)
      );
    });

    it('returns null when response is not ok', async () => {
      fetch.mockResolvedValue({ ok: false });

      const result = await restore(supabaseConfig);

      expect(result).toBeNull();
    });

    it('returns null when no rows found', async () => {
      fetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      const result = await restore(supabaseConfig);

      expect(result).toBeNull();
    });

    it('returns null when supabaseConfig is null', async () => {
      const result = await restore(null);
      expect(result).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('restoreIfMissing', () => {
    it('calls fetch when SOUL.md does not exist', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
      fetch.mockResolvedValue({
        ok: true,
        json: async () => [{ content: '# Restored Soul' }],
      });

      await restoreIfMissing(supabaseConfig);

      expect(fetch).toHaveBeenCalled();
    });

    it('writes restored content to SOUL.md path', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      const writeFileSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
      fetch.mockResolvedValue({
        ok: true,
        json: async () => [{ content: '# Restored Soul' }],
      });

      await restoreIfMissing(supabaseConfig);

      expect(writeFileSpy).toHaveBeenCalledWith(
        expect.stringContaining('SOUL.md'),
        '# Restored Soul'
      );
    });

    it('skips fetch when SOUL.md already exists', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);

      await restoreIfMissing(supabaseConfig);

      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not write file when Supabase returns no content', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      const writeFileSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
      fetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      await restoreIfMissing(supabaseConfig);

      expect(writeFileSpy).not.toHaveBeenCalled();
    });

    it('does nothing when supabaseConfig is null', async () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);

      await restoreIfMissing(null);

      expect(fetch).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
    });
  });
});
