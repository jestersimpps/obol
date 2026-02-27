const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;

const { resolveDelay, handleTool } = require('../src/curiosity/humor');

describe('curiosity-humor', () => {
  describe('resolveDelay', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('parses hours correctly', () => {
      expect(resolveDelay('2h')).toBe(new Date('2024-01-15T14:00:00.000Z').toISOString());
    });

    it('parses days correctly', () => {
      expect(resolveDelay('1d')).toBe(new Date('2024-01-16T12:00:00.000Z').toISOString());
    });

    it('parses weeks correctly', () => {
      expect(resolveDelay('1w')).toBe(new Date('2024-01-22T12:00:00.000Z').toISOString());
    });

    it('defaults to 1 day on invalid input', () => {
      expect(resolveDelay('lol')).toBe(new Date('2024-01-16T12:00:00.000Z').toISOString());
    });

    it('defaults to 1 day on empty string', () => {
      expect(resolveDelay('')).toBe(new Date('2024-01-16T12:00:00.000Z').toISOString());
    });
  });

  describe('handleTool — list_curiosity_findings', () => {
    it('returns formatted findings filtered to shareable categories', async () => {
      const selfMemory = {
        recent: vi.fn().mockResolvedValue([
          { category: 'research', content: 'black holes are loud' },
          { category: 'interest', content: 'want to learn morse code' },
          { category: 'self', content: 'i felt curious today' },
          { category: 'pattern', content: 'should not appear' },
        ]),
      };

      const result = await handleTool('list_curiosity_findings', {}, selfMemory, new Map());

      expect(selfMemory.recent).toHaveBeenCalledWith({ limit: 20 });
      expect(result).toContain('[research] black holes are loud');
      expect(result).toContain('[interest] want to learn morse code');
      expect(result).toContain('[self] i felt curious today');
      expect(result).not.toContain('should not appear');
    });

    it('uses custom limit', async () => {
      const selfMemory = { recent: vi.fn().mockResolvedValue([]) };

      await handleTool('list_curiosity_findings', { limit: 5 }, selfMemory, new Map());

      expect(selfMemory.recent).toHaveBeenCalledWith({ limit: 5 });
    });

    it('returns fallback when no shareable findings', async () => {
      const selfMemory = {
        recent: vi.fn().mockResolvedValue([{ category: 'pattern', content: 'ignore me' }]),
      };

      const result = await handleTool('list_curiosity_findings', {}, selfMemory, new Map());

      expect(result).toBe('No findings yet');
    });

    it('returns fallback when findings array is empty', async () => {
      const selfMemory = { recent: vi.fn().mockResolvedValue([]) };

      const result = await handleTool('list_curiosity_findings', {}, selfMemory, new Map());

      expect(result).toBe('No findings yet');
    });
  });

  describe('handleTool — get_user_context', () => {
    it('returns profile, patterns and events when all present', async () => {
      const userMap = new Map([
        ['42', {
          userProfile: 'loves coffee and dark humor',
          patterns: 'active at night',
          events: [
            { title: 'Birthday', description: 'turning 30' },
            { title: 'Dentist' },
          ],
        }],
      ]);

      const result = await handleTool('get_user_context', { user_id: '42' }, null, userMap);

      expect(result).toContain('loves coffee and dark humor');
      expect(result).toContain('active at night');
      expect(result).toContain('Birthday: turning 30');
      expect(result).toContain('Dentist');
    });

    it('coerces numeric user_id to string for lookup', async () => {
      const userMap = new Map([['99', { userProfile: 'numeric id user', patterns: null, events: [] }]]);

      const result = await handleTool('get_user_context', { user_id: 99 }, null, userMap);

      expect(result).toContain('numeric id user');
    });

    it('returns fallback when user not found', async () => {
      const result = await handleTool('get_user_context', { user_id: '999' }, null, new Map());

      expect(result).toBe('User not found');
    });

    it('returns fallback when user has no context fields', async () => {
      const userMap = new Map([['1', { userProfile: null, patterns: null, events: [] }]]);

      const result = await handleTool('get_user_context', { user_id: '1' }, null, userMap);

      expect(result).toBe('No context available');
    });
  });

  describe('handleTool — list_pending_events', () => {
    it('returns formatted pending events', async () => {
      const scheduler = {
        list: vi.fn().mockResolvedValue([
          { due_at: '2024-01-16T12:00:00.000Z', title: 'Curiosity humor', description: 'dark mode pun' },
          { due_at: '2024-01-17T09:00:00.000Z', title: 'Curiosity insight', description: null },
        ]),
      };
      const userMap = new Map([['5', { scheduler }]]);

      const result = await handleTool('list_pending_events', { user_id: '5' }, null, userMap);

      expect(scheduler.list).toHaveBeenCalledWith({ status: 'pending', limit: 20 });
      expect(result).toContain('Curiosity humor: dark mode pun');
      expect(result).toContain('Curiosity insight');
    });

    it('returns fallback when no pending events', async () => {
      const scheduler = { list: vi.fn().mockResolvedValue([]) };
      const userMap = new Map([['5', { scheduler }]]);

      const result = await handleTool('list_pending_events', { user_id: '5' }, null, userMap);

      expect(result).toBe('No pending events');
    });

    it('returns error when user not found', async () => {
      const result = await handleTool('list_pending_events', { user_id: '99' }, null, new Map());

      expect(result).toBe('User not found');
    });

    it('returns error when user has no scheduler', async () => {
      const userMap = new Map([['1', { scheduler: null }]]);

      const result = await handleTool('list_pending_events', { user_id: '1' }, null, userMap);

      expect(result).toBe('No scheduler');
    });
  });

  describe('handleTool — schedule_humor', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('schedules with humor delivery instructions', async () => {
      const scheduler = { add: vi.fn().mockResolvedValue({}) };
      const userMap = new Map([
        ['7', { chatId: 7, timezone: 'UTC', scheduler }],
      ]);

      const result = await handleTool(
        'schedule_humor',
        { user_id: '7', hint: 'why do programmers prefer dark mode? because light attracts bugs', delay: '3h' },
        null,
        userMap
      );

      expect(result).toBe('Scheduled');
      expect(scheduler.add).toHaveBeenCalledTimes(1);
      const [chatId, title, dueAt, timezone, hint, , , , instructions] = scheduler.add.mock.calls[0];
      expect(chatId).toBe(7);
      expect(title).toBe('Curiosity humor');
      expect(dueAt).toBe(new Date('2024-01-15T15:00:00.000Z').toISOString());
      expect(timezone).toBe('UTC');
      expect(hint).toContain('light attracts bugs');
      expect(instructions).toContain('light attracts bugs');
      expect(instructions).toContain("Don't explain it");
      expect(instructions).toContain("Don't say it's a joke");
    });

    it('returns error when user not found', async () => {
      const result = await handleTool('schedule_humor', { user_id: '0', hint: 'test', delay: '1d' }, null, new Map());

      expect(result).toBe('User not found');
    });

    it('returns error when user has no scheduler', async () => {
      const userMap = new Map([['5', { chatId: 5, timezone: 'UTC', scheduler: null }]]);

      const result = await handleTool('schedule_humor', { user_id: '5', hint: 'test', delay: '1d' }, null, userMap);

      expect(result).toBe('User has no scheduler');
    });

    it('returns error message when scheduler.add throws', async () => {
      const scheduler = { add: vi.fn().mockRejectedValue(new Error('db down')) };
      const userMap = new Map([['3', { chatId: 3, timezone: 'UTC', scheduler }]]);

      const result = await handleTool('schedule_humor', { user_id: '3', hint: 'pun', delay: '1d' }, null, userMap);

      expect(result).toBe('Failed to schedule: db down');
    });
  });

  describe('handleTool — unknown', () => {
    it('returns Unknown tool for unrecognised names', async () => {
      const result = await handleTool('does_not_exist', {}, null, new Map());

      expect(result).toBe('Unknown tool');
    });
  });
});
