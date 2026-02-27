const { describe, it, expect, vi, beforeEach } = globalThis;

const tenantModule = require('../src/tenant');
const getTenantSpy = vi.spyOn(tenantModule, 'getTenant');

const {
  clearTopicFlow,
  sendTopicEditor,
  handleTopicCallback,
  isPendingTopicInput,
  handleTopicText,
} = require('../src/telegram/topics');

function makeCtx(userId = 123) {
  return {
    from: { id: userId },
    reply: vi.fn().mockResolvedValue({ chat: { id: userId }, message_id: 100 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTenant(topics = [], enabled = true) {
  return {
    toolPrefs: new Map([
      ['proactive_news', { enabled, config: { topics } }],
    ]),
    toolPrefsApi: {
      set: vi.fn().mockResolvedValue({}),
      toggle: vi.fn().mockResolvedValue(true),
    },
    reloadToolPrefs: vi.fn().mockResolvedValue(undefined),
  };
}

describe('topics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  describe('sendTopicEditor', () => {
    it('sends editor with current topics', async () => {
      const tenant = makeTenant(['ai', 'sailing']);
      getTenantSpy.mockResolvedValue(tenant);
      const ctx = makeCtx();
      const config = {};

      await sendTopicEditor(ctx, config);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('2/20'),
        expect.objectContaining({ reply_markup: expect.anything() }),
      );
    });

    it('shows empty state when no topics', async () => {
      getTenantSpy.mockResolvedValue(makeTenant([]));
      const ctx = makeCtx();

      await sendTopicEditor(ctx, {});

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('No topics yet'),
        expect.anything(),
      );
    });

    it('returns early if no ctx.from', async () => {
      const ctx = { from: null, reply: vi.fn() };
      await sendTopicEditor(ctx, {});
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  describe('handleTopicCallback - remove', () => {
    it('removes topic at index and updates prefs', async () => {
      const tenant = makeTenant(['ai', 'sailing', 'crypto']);
      getTenantSpy.mockResolvedValue(tenant);
      const ctx = makeCtx();
      const answer = vi.fn();

      await handleTopicCallback(ctx, 'topics:remove:1', answer, {
        getTenant: getTenantSpy, config: {}, bot: { api: { deleteMessage: vi.fn() } },
      });

      expect(answer).toHaveBeenCalledWith({ text: 'Removed "sailing"' });
      expect(tenant.toolPrefsApi.set).toHaveBeenCalledWith(
        'proactive_news', true,
        expect.objectContaining({ topics: ['ai', 'crypto'] }),
      );
      expect(ctx.editMessageText).toHaveBeenCalled();
    });
  });

  describe('handleTopicCallback - add', () => {
    it('sets pending input state', async () => {
      getTenantSpy.mockResolvedValue(makeTenant(['ai']));
      const ctx = makeCtx();
      const answer = vi.fn();

      expect(isPendingTopicInput(123)).toBe(false);

      await handleTopicCallback(ctx, 'topics:add', answer, {
        getTenant: getTenantSpy, config: {}, bot: { api: { deleteMessage: vi.fn() } },
      });

      expect(isPendingTopicInput(123)).toBe(true);
      expect(ctx.reply).toHaveBeenCalledWith('Type your topics, separated by commas:');
    });

    it('auto-expires after 60s', async () => {
      getTenantSpy.mockResolvedValue(makeTenant([]));
      const ctx = makeCtx(456);
      const answer = vi.fn();

      await handleTopicCallback(ctx, 'topics:add', answer, {
        getTenant: getTenantSpy, config: {}, bot: { api: { deleteMessage: vi.fn() } },
      });

      expect(isPendingTopicInput(456)).toBe(true);
      vi.advanceTimersByTime(61_000);
      expect(isPendingTopicInput(456)).toBe(false);
    });

    it('rejects when at max topics', async () => {
      const topics = Array.from({ length: 20 }, (_, i) => `topic${i}`);
      getTenantSpy.mockResolvedValue(makeTenant(topics));
      const ctx = makeCtx(555);
      const answer = vi.fn();

      await handleTopicCallback(ctx, 'topics:add', answer, {
        getTenant: getTenantSpy, config: {}, bot: { api: { deleteMessage: vi.fn() } },
      });

      expect(isPendingTopicInput(555)).toBe(false);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Max 20'));
    });
  });

  describe('handleTopicCallback - done', () => {
    it('clears flow and answers', async () => {
      const bot = { api: { deleteMessage: vi.fn().mockResolvedValue(undefined) } };
      const ctx = makeCtx();
      const answer = vi.fn();

      await handleTopicCallback(ctx, 'topics:done', answer, {
        getTenant: getTenantSpy, config: {}, bot,
      });

      expect(answer).toHaveBeenCalledWith({ text: 'Topics saved' });
    });
  });

  describe('handleTopicText', () => {
    it('parses comma-delimited topics and merges', async () => {
      const tenant = makeTenant(['ai']);
      getTenantSpy.mockResolvedValue(tenant);
      const ctx = makeCtx();
      const bot = { api: { deleteMessage: vi.fn() } };

      await handleTopicText(ctx, 'Sailing, Crypto, AI', { getTenant: getTenantSpy, config: {}, bot });

      expect(tenant.toolPrefsApi.set).toHaveBeenCalledWith(
        'proactive_news', true,
        expect.objectContaining({ topics: ['ai', 'sailing', 'crypto'] }),
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Added 2'),
        expect.anything(),
      );
    });

    it('deduplicates and lowercases topics', async () => {
      const tenant = makeTenant([]);
      getTenantSpy.mockResolvedValue(tenant);
      const ctx = makeCtx();

      await handleTopicText(ctx, 'AI, ai, AI, sailing', { getTenant: getTenantSpy, config: {}, bot: {} });

      const setCall = tenant.toolPrefsApi.set.mock.calls[0];
      expect(setCall[2].topics).toEqual(['ai', 'sailing']);
    });

    it('handles empty input gracefully', async () => {
      getTenantSpy.mockResolvedValue(makeTenant([]));
      const ctx = makeCtx();

      await handleTopicText(ctx, '  ,  , ', { getTenant: getTenantSpy, config: {}, bot: {} });

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('No valid topics'),
      );
    });

    it('clears pending state after handling', async () => {
      getTenantSpy.mockResolvedValue(makeTenant([]));
      const ctx = makeCtx(789);

      const answer = vi.fn();
      await handleTopicCallback(ctx, 'topics:add', answer, {
        getTenant: getTenantSpy, config: {}, bot: { api: { deleteMessage: vi.fn() } },
      });
      expect(isPendingTopicInput(789)).toBe(true);

      await handleTopicText(ctx, 'test topic', { getTenant: getTenantSpy, config: {}, bot: {} });
      expect(isPendingTopicInput(789)).toBe(false);
    });
  });

  describe('clearTopicFlow', () => {
    it('deletes tracked messages', async () => {
      getTenantSpy.mockResolvedValue(makeTenant([]));
      const ctx = makeCtx(999);
      await sendTopicEditor(ctx, {});

      const deleteMessage = vi.fn().mockResolvedValue(undefined);
      const bot = { api: { deleteMessage } };

      await clearTopicFlow(999, bot);

      expect(deleteMessage).toHaveBeenCalledWith(999, 100);
    });
  });
});
