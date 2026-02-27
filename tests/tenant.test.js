const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;

const configModule = require('../src/config');
const personalityModule = require('../src/soul/personality');
const memoryModule = require('../src/memory');
const claudeModule = require('../src/claude');
const messagesModule = require('../src/messages');
const bridgeModule = require('../src/bridge');
const bgModule = require('../src/runtime/background');

vi.spyOn(configModule, 'ensureUserDir').mockImplementation((id) => `/tmp/mock-users/${id}`);
vi.spyOn(personalityModule, 'loadPersonality').mockReturnValue({
  soul: 'test soul',
  user: 'test user',
  agents: 'test agents',
});
vi.spyOn(memoryModule, 'createMemory').mockResolvedValue({ search: vi.fn(), add: vi.fn() });
vi.spyOn(claudeModule, 'createClaude').mockReturnValue({
  chat: vi.fn(),
  client: { messages: { create: vi.fn() } },
  reloadPersonality: vi.fn(),
  clearHistory: vi.fn(),
});
vi.spyOn(messagesModule, 'createMessageLog').mockReturnValue({
  log: vi.fn(),
  getRecent: vi.fn(),
  consolidate: vi.fn(),
});
vi.spyOn(bridgeModule, 'isBridgeEnabled').mockReturnValue(false);

class MockBackgroundRunner {
  constructor() {
    this.tasks = new Map();
  }
  spawn() {}
  getStatus() { return []; }
  hasRunningTasks() { return false; }
}
bgModule.BackgroundRunner = MockBackgroundRunner;

const { getTenant, clearTenant, getAllTenants } = require('../src/tenant');

const baseConfig = {
  supabase: { url: 'https://test.supabase.co', key: 'test-key' },
  anthropic: { apiKey: 'test-anthropic-key' },
  telegram: { allowedUsers: [111, 222] },
};

describe('tenant', () => {
  afterEach(() => {
    clearTenant('user-1');
    clearTenant('user-2');
    clearTenant('user-3');
    vi.clearAllMocks();
  });

  describe('getTenant', () => {
    it('creates tenant on first call', async () => {
      const tenant = await getTenant('user-1', baseConfig);
      expect(tenant).toBeDefined();
      expect(tenant.userId).toBe('user-1');
    });

    it('returns cached tenant on second call', async () => {
      const first = await getTenant('user-1', baseConfig);
      const second = await getTenant('user-1', baseConfig);
      expect(first).toBe(second);
    });

    it('only calls dependencies once for cached tenant', async () => {
      await getTenant('user-1', baseConfig);
      await getTenant('user-1', baseConfig);
      expect(configModule.ensureUserDir).toHaveBeenCalledTimes(1);
      expect(claudeModule.createClaude).toHaveBeenCalledTimes(1);
    });

    it('returns different tenants for different userIds', async () => {
      const tenant1 = await getTenant('user-1', baseConfig);
      const tenant2 = await getTenant('user-2', baseConfig);
      expect(tenant1).not.toBe(tenant2);
      expect(tenant1.userId).toBe('user-1');
      expect(tenant2.userId).toBe('user-2');
    });

    it('has expected properties', async () => {
      const tenant = await getTenant('user-1', baseConfig);
      expect(tenant).toHaveProperty('claude');
      expect(tenant).toHaveProperty('memory');
      expect(tenant).toHaveProperty('messageLog');
      expect(tenant).toHaveProperty('personality');
      expect(tenant).toHaveProperty('bg');
      expect(tenant).toHaveProperty('userDir');
      expect(tenant).toHaveProperty('userId');
    });

    it('calls ensureUserDir with userId', async () => {
      await getTenant('user-1', baseConfig);
      expect(configModule.ensureUserDir).toHaveBeenCalledWith('user-1');
    });

    it('calls loadPersonality with shared and user personality dirs', async () => {
      await getTenant('user-1', baseConfig);
      expect(personalityModule.loadPersonality).toHaveBeenCalledWith(
        expect.stringContaining('personality'),
        '/tmp/mock-users/user-1/personality',
      );
    });

    it('creates memory when supabase is configured', async () => {
      await getTenant('user-1', baseConfig);
      expect(memoryModule.createMemory).toHaveBeenCalledWith(baseConfig.supabase, 'user-1');
    });

    it('creates messageLog when supabase is configured', async () => {
      await getTenant('user-1', baseConfig);
      expect(messagesModule.createMessageLog).toHaveBeenCalled();
    });

    it('sets memory to null without supabase config', async () => {
      const config = { anthropic: { apiKey: 'key' } };
      const tenant = await getTenant('user-3', config);
      expect(tenant.memory).toBeNull();
      expect(memoryModule.createMemory).not.toHaveBeenCalled();
    });

    it('sets messageLog to null without supabase config', async () => {
      const config = { anthropic: { apiKey: 'key' } };
      const tenant = await getTenant('user-3', config);
      expect(tenant.messageLog).toBeNull();
      expect(messagesModule.createMessageLog).not.toHaveBeenCalled();
    });

    it('passes bridgeEnabled false when bridge is disabled', async () => {
      bridgeModule.isBridgeEnabled.mockReturnValue(false);
      await getTenant('user-1', baseConfig);
      expect(claudeModule.createClaude).toHaveBeenCalledWith(
        baseConfig.anthropic,
        expect.objectContaining({ bridgeEnabled: false }),
      );
    });

    it('passes bridgeEnabled true when bridge is enabled and 2+ users', async () => {
      bridgeModule.isBridgeEnabled.mockReturnValue(true);
      await getTenant('user-1', baseConfig);
      expect(claudeModule.createClaude).toHaveBeenCalledWith(
        baseConfig.anthropic,
        expect.objectContaining({ bridgeEnabled: true }),
      );
    });

    it('passes bridgeEnabled false when bridge is enabled but only 1 user', async () => {
      bridgeModule.isBridgeEnabled.mockReturnValue(true);
      const config = { ...baseConfig, telegram: { allowedUsers: [111] } };
      await getTenant('user-1', config);
      expect(claudeModule.createClaude).toHaveBeenCalledWith(
        config.anthropic,
        expect.objectContaining({ bridgeEnabled: false }),
      );
    });
  });

  describe('clearTenant', () => {
    it('removes tenant from cache', async () => {
      await getTenant('user-1', baseConfig);
      clearTenant('user-1');
      expect(getAllTenants().has('user-1')).toBe(false);
    });

    it('causes next getTenant to create fresh tenant', async () => {
      const first = await getTenant('user-1', baseConfig);
      clearTenant('user-1');
      vi.clearAllMocks();
      const second = await getTenant('user-1', baseConfig);
      expect(second).not.toBe(first);
      expect(configModule.ensureUserDir).toHaveBeenCalledTimes(1);
    });

    it('does not throw for non-existent userId', () => {
      expect(() => clearTenant('non-existent')).not.toThrow();
    });
  });

  describe('getAllTenants', () => {
    it('returns a Map', () => {
      expect(getAllTenants()).toBeInstanceOf(Map);
    });

    it('returns empty map when no tenants exist', () => {
      expect(getAllTenants().size).toBe(0);
    });

    it('contains created tenants', async () => {
      await getTenant('user-1', baseConfig);
      await getTenant('user-2', baseConfig);
      const all = getAllTenants();
      expect(all.size).toBe(2);
      expect(all.has('user-1')).toBe(true);
      expect(all.has('user-2')).toBe(true);
    });
  });
});
