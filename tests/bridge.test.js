const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;

vi.mock('../src/claude', () => ({ createAnthropicClient: vi.fn() }));

const {
  isBridgeEnabled,
  getPartnerUserId,
  checkBridgeRateLimit,
  buildBridgeTool,
  buildBridgeTellTool,
} = require('../src/bridge');

describe('isBridgeEnabled', () => {
  it('returns true when config.bridge.enabled is true', () => {
    expect(isBridgeEnabled({ bridge: { enabled: true } })).toBe(true);
  });

  it('returns false when config.bridge is missing', () => {
    expect(isBridgeEnabled({})).toBe(false);
  });

  it('returns false when config.bridge.enabled is false', () => {
    expect(isBridgeEnabled({ bridge: { enabled: false } })).toBe(false);
  });
});

describe('getPartnerUserId', () => {
  it('returns partner when 2 users configured and no targetId', () => {
    const config = { telegram: { allowedUsers: [100, 200] } };
    const result = getPartnerUserId(100, config);
    expect(result).toEqual({ partnerId: 200 });
  });

  it('returns error for self-bridging', () => {
    const config = { telegram: { allowedUsers: [100, 200] } };
    const result = getPartnerUserId(100, config, 100);
    expect(result).toEqual({ error: 'Cannot bridge to yourself.' });
  });

  it('returns error when targetId not in allowed list', () => {
    const config = { telegram: { allowedUsers: [100, 200] } };
    const result = getPartnerUserId(100, config, 999);
    expect(result.error).toContain('999');
    expect(result.error).toContain('not in the allowed users list');
  });

  it('requires partner_id when 3+ users and no targetId', () => {
    const config = { telegram: { allowedUsers: [100, 200, 300] } };
    const result = getPartnerUserId(100, config);
    expect(result.error).toContain('Multiple users available');
    expect(result.error).toContain('200');
    expect(result.error).toContain('300');
  });

  it('returns error when no other users', () => {
    const config = { telegram: { allowedUsers: [100] } };
    const result = getPartnerUserId(100, config);
    expect(result.error).toContain('No other users configured');
  });
});

describe('checkBridgeRateLimit', () => {
  it('allows requests under the limit', () => {
    const userId = 'rate-limit-under-' + Date.now();
    const result = checkBridgeRateLimit(userId);
    expect(result).toBeNull();
  });

  it('blocks at 20 requests per hour', () => {
    const userId = 'rate-limit-block-' + Date.now();

    for (let i = 0; i < 20; i++) {
      const r = checkBridgeRateLimit(userId);
      expect(r).toBeNull();
    }

    const blocked = checkBridgeRateLimit(userId);
    expect(blocked).toBeTypeOf('string');
    expect(blocked).toContain('rate limit');
  });
});

describe('buildBridgeTool', () => {
  it('returns valid tool schema with name bridge_ask', () => {
    const tool = buildBridgeTool();
    expect(tool.name).toBe('bridge_ask');
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.properties).toHaveProperty('question');
    expect(tool.input_schema.required).toContain('question');
  });
});

describe('buildBridgeTellTool', () => {
  it('returns valid tool schema with name bridge_tell', () => {
    const tool = buildBridgeTellTool();
    expect(tool.name).toBe('bridge_tell');
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.properties).toHaveProperty('message');
    expect(tool.input_schema.required).toContain('message');
  });
});
