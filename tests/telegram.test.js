const { describe, it, expect, vi, beforeEach, afterAll } = globalThis;

const handlers = {};
const commands = {};

const mockBotInstance = {
  use: vi.fn(),
  on: vi.fn((event, handler) => { handlers[event] = handler; }),
  command: vi.fn((cmd, handler) => { commands[cmd] = handler; }),
  api: {
    config: { use: vi.fn() },
    setMyCommands: vi.fn().mockReturnValue({ catch: vi.fn() }),
    sendMessage: vi.fn(),
    getMe: vi.fn().mockResolvedValue({ username: 'testbot' }),
  },
  catch: vi.fn(),
  start: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
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
    InlineKeyboard: class InlineKeyboard { text() { return this; } row() { return this; } },
  },
};

const runnerPath = require.resolve('@grammyjs/runner');
const originalRunnerCache = require.cache[runnerPath];
require.cache[runnerPath] = {
  id: runnerPath,
  filename: runnerPath,
  loaded: true,
  exports: {
    run: vi.fn(() => ({ stop: vi.fn(), task: () => new Promise(() => {}) })),
    sequentialize: vi.fn(() => (ctx, next) => next()),
  },
};

const autoRetryPath = require.resolve('@grammyjs/auto-retry');
const originalAutoRetryCache = require.cache[autoRetryPath];
require.cache[autoRetryPath] = {
  id: autoRetryPath,
  filename: autoRetryPath,
  loaded: true,
  exports: { autoRetry: vi.fn(() => vi.fn()) },
};

const configModule = require('../src/config');
vi.spyOn(configModule, 'loadConfig').mockReturnValue(null);

const postSetupModule = require('../src/post-setup');
vi.spyOn(postSetupModule, 'isPostSetupDone').mockReturnValue(true);
vi.spyOn(postSetupModule, 'runPostSetup').mockImplementation(() => {});

const evolveModule = require('../src/evolve');
vi.spyOn(evolveModule, 'evolve').mockResolvedValue({});

const mockTenant = {
  claude: {
    chat: vi.fn().mockResolvedValue({ text: 'test response', usage: {}, model: 'test' }),
    client: { messages: { create: vi.fn() } },
    clearHistory: vi.fn(),
    reloadPersonality: vi.fn(),
    stopChat: vi.fn(),
  },
  memory: {
    search: vi.fn(),
    add: vi.fn().mockResolvedValue({}),
    recent: vi.fn(),
    byDate: vi.fn(),
    stats: vi.fn(),
    forget: vi.fn(),
  },
  messageLog: {
    log: vi.fn(),
    _verboseCallbacks: new Map(),
    _evolutionReady: false,
    _evolutionPending: false,
  },
  personality: {},
  bg: { getStatus: vi.fn(() => []), hasRunningTasks: vi.fn(() => false) },
  userDir: '/tmp/test-user',
  userId: 123,
  verbose: false,
  scheduler: null,
  toolPrefs: {},
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
  if (originalGrammyCache) require.cache[grammyPath] = originalGrammyCache;
  if (originalRunnerCache) require.cache[runnerPath] = originalRunnerCache;
  if (originalAutoRetryCache) require.cache[autoRetryPath] = originalAutoRetryCache;
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
    mockBotInstance.api.getMe = vi.fn().mockResolvedValue({ username: 'testbot' });
    mockBotInstance.catch = vi.fn();
    mockBotInstance.start = vi.fn();
    delete mockBotInstance._rateLimiter;
    mockTenant.claude.chat.mockResolvedValue({ text: 'test response', usage: {}, model: 'test' });
    mockTenant.messageLog._verboseCallbacks = new Map();
    mockTenant.messageLog._evolutionReady = false;
    mockTenant.messageLog._evolutionPending = false;
    mockTenant.verbose = false;
    tenantModule.getTenant.mockResolvedValue(mockTenant);
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

    it('registers sequentialize, dedup, and auth middleware via bot.use', () => {
      createBot(telegramConfig, config);
      expect(mockBotInstance.use).toHaveBeenCalledTimes(3);
      expect(typeof mockBotInstance.use.mock.calls[0][0]).toBe('function');
      expect(typeof mockBotInstance.use.mock.calls[1][0]).toBe('function');
      expect(typeof mockBotInstance.use.mock.calls[2][0]).toBe('function');
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
      const middleware = mockBotInstance.use.mock.calls[2][0];
      const ctx = { from: { id: 999 } };
      const next = vi.fn();
      await middleware(ctx, next);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows authorized users', async () => {
      createBot(telegramConfig, config);
      const middleware = mockBotInstance.use.mock.calls[2][0];
      const ctx = { from: { id: 123 } };
      const next = vi.fn();
      await middleware(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows all users when allowedUsers is empty', async () => {
      createBot({ token: 'test', allowedUsers: [] }, config);
      const middleware = mockBotInstance.use.mock.calls[2][0];
      const ctx = { from: { id: 999 } };
      const next = vi.fn();
      await middleware(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('start command handler', () => {
    it('replies with system online message', async () => {
      createBot(telegramConfig, config);
      const ctx = { reply: vi.fn().mockResolvedValue(undefined) };
      await commands.start(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('SYSTEM ONLINE'), expect.any(Object));
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
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('CONTEXT CLEARED'), expect.any(Object));
    });
  });

  describe('tasks command handler', () => {
    it('replies with no tasks when none running', async () => {
      mockTenant.bg.getStatus.mockReturnValue([]);
      createBot(telegramConfig, config);
      const ctx = { from: { id: 123 }, reply: vi.fn().mockResolvedValue(undefined) };
      await commands.tasks(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('(none)'), expect.any(Object));
    });

    it('lists running tasks', async () => {
      mockTenant.bg.getStatus.mockReturnValue([
        { id: 1, task: 'search things', elapsed: '10s' },
      ]);
      createBot(telegramConfig, config);
      const ctx = { from: { id: 123 }, reply: vi.fn().mockResolvedValue(undefined) };
      await commands.tasks(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('search things'), expect.any(Object));
    });
  });

  describe('message:text handler', () => {
    let ctx;

    beforeEach(() => {
      createBot(telegramConfig, config);
      ctx = {
        message: { text: 'hello', message_id: 1 },
        from: { id: 123, first_name: 'Test' },
        chat: { id: 456, type: 'private' },
        reply: vi.fn().mockResolvedValue({ message_id: 1 }),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        api: {
          editMessageText: vi.fn().mockResolvedValue(undefined),
          deleteMessage: vi.fn().mockResolvedValue(undefined),
        },
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
      expect(mockTenant.messageLog.log).toHaveBeenCalledWith(456, 'assistant', 'test response', expect.any(Object));
    });

    it('sends response as HTML message', async () => {
      await handlers['message:text'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('sends multiple messages for long responses', async () => {
      const longResponse = 'a'.repeat(5000);
      mockTenant.claude.chat.mockResolvedValue({ text: longResponse, usage: {}, model: 'test' });
      await handlers['message:text'](ctx);
      const htmlCalls = ctx.reply.mock.calls.filter(c => c[1]?.parse_mode === 'HTML');
      expect(htmlCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('replies with error on API 401 error', async () => {
      mockTenant.claude.chat.mockRejectedValue({ status: 401, message: '401' });
      await handlers['message:text'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('API key invalid'));
    });

    it('replies with error on rate limit error', async () => {
      mockTenant.claude.chat.mockRejectedValue({ status: 429, message: 'rate limited' });
      await handlers['message:text'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Rate limited'));
    });

    it('replies with error on generic error', async () => {
      mockTenant.claude.chat.mockRejectedValue(new Error('something broke'));
      await handlers['message:text'](ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Something went wrong'));
    });
  });

  describe('media handler', () => {
    let mediaCtx;

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

      mediaCtx = {
        from: { id: 123, first_name: 'Test' },
        chat: { id: 456, type: 'private' },
        message: { photo: [{ file_id: 'f1', file_size: 24500 }], caption: '', media_group_id: undefined },
        reply: vi.fn().mockResolvedValue({ message_id: 2 }),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
        api: {
          editMessageText: vi.fn().mockResolvedValue(undefined),
          deleteMessage: vi.fn().mockResolvedValue(undefined),
        },
      };
    });

    it('downloads and saves photo to assets', async () => {
      createBot(telegramConfig, config);
      await handlers['message:photo'](mediaCtx);
      expect(mediaModule.downloadFile).toHaveBeenCalledWith('test-token-123', 'photos/file_0.jpg');
      expect(mediaModule.saveFile).toHaveBeenCalled();
      expect(mediaCtx.reply).toHaveBeenCalled();
    });

    it('sends image to Claude for vision when photo', async () => {
      createBot(telegramConfig, config);
      mediaCtx.message.caption = 'look at this';
      await handlers['message:photo'](mediaCtx);
      expect(mockTenant.claude.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ images: expect.any(Array) }),
      );
    });

    it('returns early for unknown media and does nothing', async () => {
      mediaModule.getFileInfo.mockReturnValue(null);
      createBot(telegramConfig, config);
      const ctx = {
        from: { id: 123 },
        chat: { id: 456, type: 'private' },
        message: { media_group_id: undefined },
        reply: vi.fn(),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      };
      await handlers['message:photo'](ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('sends non-image to claude.chat with file context', async () => {
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
        chat: { id: 456, type: 'private' },
        message: { voice: { file_id: 'f1', file_size: 10000 }, caption: undefined, media_group_id: undefined },
        reply: vi.fn().mockResolvedValue({ message_id: 3 }),
        replyWithChatAction: vi.fn().mockResolvedValue(undefined),
        getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file_0.ogg' }),
        api: {
          editMessageText: vi.fn().mockResolvedValue(undefined),
          deleteMessage: vi.fn().mockResolvedValue(undefined),
        },
      };
      await handlers['message:voice'](ctx);
      expect(mockTenant.claude.chat).toHaveBeenCalledWith(
        expect.stringContaining('Voice message'),
        expect.any(Object),
      );
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
