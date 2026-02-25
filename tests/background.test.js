const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;

const { BackgroundRunner } = require('../src/background');

describe('BackgroundRunner', () => {
  let runner;
  let mockClaude;
  let mockCtx;
  let mockMemory;

  beforeEach(() => {
    vi.useFakeTimers();
    runner = new BackgroundRunner();
    mockClaude = {
      chat: vi.fn().mockResolvedValue('done'),
      clearHistory: vi.fn(),
    };
    mockCtx = {
      chat: { id: 123 },
      reply: vi.fn().mockResolvedValue(undefined),
      replyWithChatAction: vi.fn().mockResolvedValue(undefined),
    };
    mockMemory = {
      add: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    for (const task of runner.tasks.values()) {
      if (task.checkInTimer) clearInterval(task.checkInTimer);
    }
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('initializes with empty tasks map', () => {
      expect(runner.tasks.size).toBe(0);
    });

    it('initializes task counter at 0', () => {
      expect(runner.taskCounter).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('returns empty array when no tasks exist', () => {
      expect(runner.getStatus()).toEqual([]);
    });

    it('returns running tasks with elapsed time', () => {
      runner.tasks.set(1, {
        task: 'test task',
        status: 'running',
        startedAt: Date.now() - 45000,
      });

      const status = runner.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0].id).toBe(1);
      expect(status[0].task).toBe('test task');
      expect(status[0].elapsed).toBe('45s');
    });

    it('formats elapsed time in minutes when over 60s', () => {
      runner.tasks.set(1, {
        task: 'long task',
        status: 'running',
        startedAt: Date.now() - 125000,
      });

      const status = runner.getStatus();
      expect(status[0].elapsed).toBe('2m 5s');
    });

    it('formats elapsed time as exact minutes when no remainder', () => {
      runner.tasks.set(1, {
        task: 'exact task',
        status: 'running',
        startedAt: Date.now() - 120000,
      });

      const status = runner.getStatus();
      expect(status[0].elapsed).toBe('2m');
    });

    it('truncates task description to 80 characters', () => {
      const longTask = 'a'.repeat(200);
      runner.tasks.set(1, {
        task: longTask,
        status: 'running',
        startedAt: Date.now(),
      });

      const status = runner.getStatus();
      expect(status[0].task).toHaveLength(80);
    });

    it('excludes non-running tasks', () => {
      runner.tasks.set(1, { task: 'done task', status: 'done', startedAt: Date.now() });
      runner.tasks.set(2, { task: 'error task', status: 'error', startedAt: Date.now() });
      runner.tasks.set(3, { task: 'running task', status: 'running', startedAt: Date.now() });

      const status = runner.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0].id).toBe(3);
    });
  });

  describe('hasRunningTasks', () => {
    it('returns false when no tasks exist', () => {
      expect(runner.hasRunningTasks()).toBe(false);
    });

    it('returns false when all tasks are done', () => {
      runner.tasks.set(1, { status: 'done' });
      runner.tasks.set(2, { status: 'error' });
      expect(runner.hasRunningTasks()).toBe(false);
    });

    it('returns true when a running task exists', () => {
      runner.tasks.set(1, { status: 'done' });
      runner.tasks.set(2, { status: 'running' });
      expect(runner.hasRunningTasks()).toBe(true);
    });
  });

  describe('spawn', () => {
    it('returns incrementing task IDs', () => {
      const id1 = runner.spawn(mockClaude, 'task 1', mockCtx, mockMemory);
      const id2 = runner.spawn(mockClaude, 'task 2', mockCtx, mockMemory);
      const id3 = runner.spawn(mockClaude, 'task 3', mockCtx, mockMemory);

      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(id3).toBe(3);
    });

    it('adds task to internal tasks map', () => {
      const id = runner.spawn(mockClaude, 'my task', mockCtx, mockMemory);

      expect(runner.tasks.has(id)).toBe(true);
      const task = runner.tasks.get(id);
      expect(task.task).toBe('my task');
      expect(task.chatId).toBe(123);
    });

    it('sets task status to running', () => {
      const id = runner.spawn(mockClaude, 'my task', mockCtx, mockMemory);

      const task = runner.tasks.get(id);
      expect(task.status).toBe('running');
    });

    it('records startedAt timestamp', () => {
      const now = Date.now();
      const id = runner.spawn(mockClaude, 'my task', mockCtx, mockMemory);

      const task = runner.tasks.get(id);
      expect(task.startedAt).toBe(now);
    });

    it('stores task description on spawned task', () => {
      const id = runner.spawn(mockClaude, 'my task', mockCtx, mockMemory);

      const task = runner.tasks.get(id);
      expect(task.task).toBe('my task');
    });

    it('makes hasRunningTasks return true', () => {
      runner.spawn(mockClaude, 'my task', mockCtx, mockMemory);
      expect(runner.hasRunningTasks()).toBe(true);
    });

    it('makes getStatus include the spawned task', () => {
      runner.spawn(mockClaude, 'my task', mockCtx, mockMemory);

      const status = runner.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0].task).toBe('my task');
    });

    it('stores promise on spawned task', () => {
      const id = runner.spawn(mockClaude, 'my task', mockCtx, mockMemory);

      const task = runner.tasks.get(id);
      expect(task.promise).toBeDefined();
    });

    it('calls claude.chat to run the task', () => {
      runner.spawn(mockClaude, 'my task', mockCtx, mockMemory);
      expect(mockClaude.chat).toHaveBeenCalledTimes(1);
      expect(mockClaude.chat).toHaveBeenCalledWith(
        expect.stringContaining('my task'),
        expect.objectContaining({ chatId: 'bg-1', userName: 'BackgroundTask' }),
      );
    });
  });
});
