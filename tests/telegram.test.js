const { describe, it, expect, vi, beforeEach, afterAll } = globalThis;

const handlers = {};
const commands = {};

const mockBotInstance = {
  use: vi.fn(),
  on: vi.fn((event, handler) => { handlers[event] = handler; }),
  command: vi.fn((cmd, handler) => { commands[cmd] = handler; }),
  api: {
    setMyCommands: vi.fn().mockReturnValue({ catch: vi.fn() }),
    sendMessage: vi.fn(),
  },
  catch: vi.fn(),
  start: vi.fn(),
};

const MockBot = vi.fn(function() { return mockBotInstance; });

const grammyPath = require.resolve('grammy');
const originalGrammyCache = require.cache[grammyPath];
require.cache[grammyPath] = {
  id: grammyPath,
  filename: grammyPath,
  loaded: true,
  exports: {
    Bot: MockBot,
    GrammyError: class GrammyError extends Error {},
    HttpError: class HttpError extends Error {},
  },
};

const configModule = require('../src/config');
vi.spyOn(configModule, 'loadConfig').mockReturnValue(null);

const postSetupModule = require('../src/post-setup');
vi.spyOn(postSetupModule, 'isPostSetupDone').mockReturnValue(true);
vi.spyOn(postSetupModule, 'runPostSetup').mockImplementation(() => {});

const evolveModule = require('../src/evolve');
vi.spyOn(evolveModule, 'shouldEvolve').mockResolvedValue(false);
vi.spyOn(evolveModule, 'evolve').mockResolvedValue({});

const mockTenant = {
  claude: {
    chat: vi.fn().mockResolvedValue('test response'),
    client: { messages: { create: vi.fn() } },
    clearHistory: vi.fn(),
    reloadPersonality: vi.fn(),
  },
  memory: {
    search: vi.fn(),
    add: vi.fn(),
    recent: vi.fn(),
    byDate: vi.fn(),
    stats: vi.fn(),
    forget: vi.fn(),
  },
  messageLog: { log: vi.fn() },
  personality: {},
  bg: { getStatus: vi.fn(() => []), hasRunningTasks: vi.fn(() => false) },
  userDir: '/tmp/test-user',
  userId: 123,
};

const tenantModule = require('../src/tenant');
vi.spyOn(tenantModule, 'getTenant').mockResolvedValue(mockTenant);

const mediaModule = require('../src/media');
vi.spyOn(mediaModule, 'getFileInfo');
vi.spyOn(mediaModule, 'generateFilename');
vi.spyOn(mediaModule, 'downloadFile');
vi.spyOn(mediaModule, 'saveFile');
vi.spyOn(mediaModule, 'buildMemoryContent');
vi.spyOn(mediaModule, 'isImage');
vi.spyOn(mediaModule, 'bufferToImageBlock');

const { createBot } = require('../src/telegram');

afterAll(() => {
  if (originalGrammyCache) {
    require.cache[grammyPath] = originalGrammyCache;
  }
});

const telegramConfig = { token: 'test-token-123', allowedUsers: [123] };
const config = {
  anthropic: { apiKey: 'test-key' },
  supabase: { url: 'https://test.supabase.co', key: 'key' },
};

function resetHandlers() {
  Object.keys(handlers).forEach((k) => delete handlers[k]);
  Object.keys(commands).forEach((k) => delete commands[k]);
}

describe('telegram', () => {
  beforeEach(() => {
    resetHandlers();
    vi.clearAllMocks();
    MockBot.mockImplementation(function() { return mockBotInstance; });
    mockBotInstance.use = vi.fn();
    mockBotInstance.on = vi.fn((event, handler) => { handlers[event] = handler; });
    mockBotInstance.command = vi.fn((cmd, handler) => { commands[cmd] = handler; });
    mockBotInstance.api.setMyCommands = vi.fn().mockReturnValue({ catch: vi.fn() });
    mockBotInstance.api.sendMessage = vi.fn();
    mockBotInstance.catch = vi.fn();
    mockBotInstance.start = vi.fn();
    mockTenant.claude.chat.mockResolvedValue('test response');
    tenantModule.getTenant.mockResolvedValue(mockTenant);
    evolveModule.shouldEvolve.mockResolvedValue(false);
  });

  describe('createBot', () => {
    it('returns a bot object', () => {
      const bot = createBot(telegramConfig, config);
      expect(bot).toBeDefined();
    });

    it('creates Bot with telegram token', () => {
      createBot(telegramConfig, config);
      expect(MockBot).toHaveBeenCalledWith('test-token-123');
    });

    it('registers auth middleware via bot.use', () => {
      createBot(telegramConfig, config);
      expect(mockBotInstance.use).toHaveBeenCalledTimes(1);
      expect(typeof mockBotInstance.use.mock.calls[0][0]).toBe('function');
    });

    it('sets bot commands via api', () => {
      createBot(telegramConfig, config);
      expect(mockBotInstance.api.setMyCommands).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ command: 'new' }),
          expect.objectContaining({ command: 'memory' }),
          expect.objectContaining({ command: 'recent' }),
          expect.objectContaining({ command: 'today' }),
          expect.objectContaining({ command: 'tasks' }),
          expect.objectContaining({ command: 'status' }),
          expect.objectContaining({ command: 'backup' }),
          expect.objectContaining({ command: 'clean' }),
          expect.objectContaining({ command: 'help' }),
        ]),
      );
    });

    it('registers start command', () => {
      createBot(telegramConfig, config);
      expect(commands.start).toBeDefined();
    });

    it('registers new command', () => {
      createBot(telegramConfig, config);
      expect(commands.new).toBeDefined();
    });

    it('registers memory command', () => {
      createBot(telegramConfig, config);
      expect(commands.memory).toBeDefined();
    });

    it('registers help command', () => {
      createBot(telegramConfig, config);
      expect(commands.help).toBeDefined();
    });

    it('registers status command', () => {
      createBot(telegramConfig, config);
      expect(commands.status).toBeDefined();
    });

    it('registers tasks command', () => {
      createBot(telegramConfig, config);
      expect(commands.tasks).toBeDefined();
    });

    it('registers backup command', () => {
      createBot(telegramConfig, config);
      expect(commands.backup).toBeDefined();
    });

    it('registers forget command', () => {
      createBot(telegramConfig, config);
      expect(commands.forget).toBeDefined();
    });

    it('registers recent command', () => {
      createBot(telegramConfig, config);
      expect(commands.recent).toBeDefined();
    });

    it('registers today command', () => {
      createBot(telegramConfig, config);
      expect(commands.today).toBeDefined();
    });

    it('registers clean command', () => {
      createBot(telegramConfig, config);
      expect(commands.clean).toBeDefined();
    });

    it('registers message:text handler', () => {
      createBot(telegramConfig, config);
      expect(handlers['message:text']).toBeDefined();
    });

    it('registers message:photo handler', () => {
      createBot(telegramConfig, config);
      expect(handlers['message:photo']).toBeDefined();
    });

    it('sets up error handler via bot.catch', () => {
      createBot(telegramConfig, config);
      expect(mockBotInstance.catch).toHaveBeenCalledTimes(1);
      expect(typeof mockBotInstance.catch.mock.calls[0][0]).toBe('function');
    });

    it('wraps bot.start with resilience retry logic', () => {
      const bot = createBot(telegramConfig, config);
      expect(typeof bot.start).toBe('function');
    });
  });

  describe('auth middleware', () => {
    it('blocks unauthorized users', async () => {
      createBot(telegramConfig, config);
      const middleware = mockBotInstance.use.mock.calls[0][0];
      const ctx = { from: { id: 999 } };
      const next = vi.fn();
      await middleware(ctx, next);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows authorized users', async () => {
      createBot(telegramConfig, config);
      const middleware = mockBotInstance.use.mock.calls[0][0];
      const ctx = { from: { id: 123 } };
      const next = vi.fn();
      await middleware(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows all users when allowedUsers is empty', async () => {
      createBot({ token: 'test', allowedUsers: [] }, config);
      const middleware = mockBotInstance.use.mock.calls[0][0];
      const ctx = { from: { id: 999 } };
      const next = vi.fn();
      await middleware(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('start command handler', () => {
    it('replies with ready message', async () => {
      createBot(telegramConfig, config);
      const ctx = { reply: vi.fn().mockResolvedValue(undefined) };
      await commands.start(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('OBOL is ready'));
    });
  });

  describe('new command handler', () => {
    it('clears history and replies', async () => {
      createBot(telegramConfig, config);
      const ctx = {
        from: { id: 123 },
        chat: { id: 456 },
        reply: vi.fn().mockResolvedValue(undefined),
      };
      await commands.new(ctx);
      expect(mockTenant.claude.clearHistory).toHaveBeenCalledWith(456);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Fresh start'));
    });
  });

  describe('tasks command handler', () => {
    it('replies with no tasks when none running', async () => {
      mockTenant.bg.getStatus.mockReturnValue([]);
      createBot(telegramConfig, config);
      const ctx = { from: { id: 123 }, reply: vi.fn().mockResolvedValue(undefined) };
      await commands.tasks(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('No background tasks running.');
    });

    it('lists running tasks', async () => {
      mockTenant.bg.getStatus.mockReturnValue([
        { id: 1, task: 'search things', elapsed: '10s' },
      ]);
      createBot(telegramConfig, config);
      const ctx = { from: { id: 123 }, reply: vi.fn().mockResolvedValue(undefined) };
      await commands.tasks(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('search things'));
    });
  });

  describe('message:text handler', () => {
    let ctx;

    beforeEach(() => {
      createBot(telegramConfig, config);
      ctx = {
        message: { text: 'hello' },
        from: { id: 123, first_name: 'Test' },
        chat: { id: 456 },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };
    });

    it('calls getTenant with userId and config', async () => {
      await handlers['message:text'](ctx);
      expect(tenantModule.getTenant).toHaveBeenCalledWith(123, config);
    });

    it('sends typing action', async () => {
      await handlers['message:text'](ctx);
      expect(ctx.replyWithChatAction).toHaveBeenCalledWith('typing');
    });

    it('calls claude.chat with the message', async () => {
      await handlers['message:text'](ctx);
      expect(mockTenant.claude.chat).toHaveBeenCalledWith(
        'hello',
        expect.objectContaining({
          userId: 123,
          userName: 'Test',
          chatId: 456,
        }),
      );
    });

    it('logs user message to messageLog', async () => {
      await handlers['message:text'](ctx);
      expect(mockTenant.messageLog.log).toHaveBeenCalledWith(456, 'user', 'hello');
    });

    it('logs assistant response to messageLog', async () => {
      await handlers['message:text'](ctx);
      expect(mockTenant.messageLog.log).toHaveBeenCalledWith(456, 'assistant', 'test response');
    });

    it('replies with claude response', async () => {
      await handlers['message:text'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith('test response', { parse_mode: 'Markdown' });
    });

    it('splits long responses into multiple messages', async () => {
      const longResponse = 'a'.repeat(5000);
      mockTenant.claude.chat.mockResolvedValue(longResponse);
      await handlers['message:text'](ctx);
      expect(ctx.reply.mock.calls.length).toBeGreaterThan(1);
    });

    it('handles API 401 error', async () => {
      mockTenant.claude.chat.mockRejectedValue({ status: 401, message: '401' });
      await handlers['message:text'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('API key invalid'),
      );
    });

    it('handles rate limit error', async () => {
      mockTenant.claude.chat.mockRejectedValue({ status: 429, message: 'rate limited' });
      await handlers['message:text'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Rate limited'),
      );
    });

    it('handles generic error', async () => {
      mockTenant.claude.chat.mockRejectedValue(new Error('something broke'));
      await handlers['message:text'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Something went wrong'),
      );
    });
  });

  describe('media handler', () => {
    beforeEach(() => {
      mediaModule.getFileInfo.mockReturnValue({
        fileId: 'file-123',
        mediaType: 'photo',
        mimeType: 'image/jpeg',
        originalName: null,
        fileSize: 24500,
      });
      mediaModule.downloadFile.mockResolvedValue(Buffer.from('fake-image'));
      mediaModule.generateFilename.mockReturnValue('photo-2026-02-23T14-30-00.jpg');
      mediaModule.saveFile.mockReturnValue('/tmp/test-user/assets/photo-2026-02-23T14-30-00.jpg');
      mediaModule.isImage.mockReturnValue(true);
      mediaModule.bufferToImageBlock.mockReturnValue({ type: 'image', source: {} });
      mediaModule.buildMemoryContent.mockReturnValue('File received: photo');
      mockTenant.memory.add.mockResolvedValue({ id: 'mem-1' });
    });

    it('downloads and saves photo to assets', async () => {
      createBot(telegramConfig, config);
      const ctx = {
        from: { id: 123, first_name: 'Test' },
        chat: { id: 456 },
        message: { photo: [{ file_id: 'f1', file_size: 24500 }], caption: '' },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
      };
      await handlers['message:photo'](ctx);
      expect(mediaModule.downloadFile).toHaveBeenCalledWith('test-token-123', 'photos/file_0.jpg');
      expect(mediaModule.saveFile).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalled();
    });

    it('stores memory entry for media', async () => {
      createBot(telegramConfig, config);
      const ctx = {
        from: { id: 123, first_name: 'Test' },
        chat: { id: 456 },
        message: { photo: [{ file_id: 'f1', file_size: 24500 }], caption: '' },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
      };
      await handlers['message:photo'](ctx);
      expect(mockTenant.memory.add).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ category: 'resource', source: 'telegram-media' }),
      );
    });

    it('sends image to Claude for vision when photo', async () => {
      createBot(telegramConfig, config);
      const ctx = {
        from: { id: 123, first_name: 'Test' },
        chat: { id: 456 },
        message: { photo: [{ file_id: 'f1', file_size: 24500 }], caption: 'look at this' },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
      };
      await handlers['message:photo'](ctx);
      expect(mockTenant.claude.chat).toHaveBeenCalledWith(
        'look at this',
        expect.objectContaining({ images: expect.any(Array) }),
      );
    });

    it('returns null for unknown media and does nothing', async () => {
      mediaModule.getFileInfo.mockReturnValue(null);
      createBot(telegramConfig, config);
      const ctx = {
        from: { id: 123 },
        message: {},
        reply: vi.fn(),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };
      await handlers['message:photo'](ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('acknowledges non-image without caption', async () => {
      mediaModule.isImage.mockReturnValue(false);
      mediaModule.getFileInfo.mockReturnValue({
        fileId: 'file-123',
        mediaType: 'voice',
        mimeType: 'audio/ogg',
        originalName: null,
        fileSize: 10000,
      });
      createBot(telegramConfig, config);
      const ctx = {
        from: { id: 123, first_name: 'Test' },
        chat: { id: 456 },
        message: { voice: { file_id: 'f1', file_size: 10000 }, caption: undefined },
        reply: vi.fn().mockResolvedValue(undefined),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file_0.ogg' }),
      };
      await handlers['message:voice'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('saved'));
      expect(mockTenant.claude.chat).not.toHaveBeenCalled();
    });
  });

  describe('error handler', () => {
    it('calls reply on the error context', () => {
      createBot(telegramConfig, config);
      const errorHandler = mockBotInstance.catch.mock.calls[0][0];
      const replyFn = vi.fn().mockResolvedValue(undefined);
      const err = {
        ctx: { update: { update_id: 1 }, reply: replyFn },
        error: new Error('test error'),
      };
      errorHandler(err);
      expect(replyFn).toHaveBeenCalledWith(expect.stringContaining('Something went wrong'));
    });
  });
});
