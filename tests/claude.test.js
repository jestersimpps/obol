const { describe, it, expect, vi, beforeEach, afterEach } = globalThis;

vi.mock('../src/oauth', () => ({
  refreshTokens: vi.fn(),
  isExpired: vi.fn().mockReturnValue(false),
  isOAuthToken: vi.fn(),
}));

vi.mock('../src/config', () => ({
  OBOL_DIR: '/tmp/obol-test',
  saveConfig: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock('../src/personality', () => ({
  loadPersonality: vi.fn().mockReturnValue({ soul: 'test soul' }),
}));

vi.mock('../src/bridge', () => ({
  buildBridgeTool: vi.fn(() => ({
    name: 'bridge_ask',
    description: 'Ask partner',
    input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  })),
  buildBridgeTellTool: vi.fn(() => ({
    name: 'bridge_tell',
    description: 'Tell partner',
    input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  })),
}));

const Anthropic = require('@anthropic-ai/sdk');
const { createAnthropicClient, createClaude } = require('../src/claude');

function stubClient(client, mockFn) {
  client.messages.create = mockFn;
}

describe('createAnthropicClient', () => {
  it('creates client with apiKey when no oauth configured', () => {
    const client = createAnthropicClient({ apiKey: 'sk-test-key-123' });

    expect(client).toBeInstanceOf(Anthropic);
    expect(client.apiKey).toBe('sk-test-key-123');
  });

  it('creates client with authToken when oauth configured', () => {
    const client = createAnthropicClient({
      oauth: { accessToken: 'oauth-access-token-abc' },
    });

    expect(client).toBeInstanceOf(Anthropic);
    expect(client.authToken).toBe('oauth-access-token-abc');
  });

  it('sets apiKey to null when oauth configured', () => {
    const client = createAnthropicClient({
      oauth: { accessToken: 'oauth-access-token-abc' },
    });

    expect(client.apiKey).toBeNull();
  });

  it('returns an object with messages.create method', () => {
    const client = createAnthropicClient({ apiKey: 'sk-test' });

    expect(client).toHaveProperty('messages');
    expect(client.messages.create).toBeTypeOf('function');
  });
});

describe('createClaude', () => {
  it('returns object with chat, client, reloadPersonality, clearHistory', () => {
    const result = createClaude(
      { apiKey: 'sk-test' },
      { personality: { soul: 'test' }, memory: null, userDir: '/tmp/obol-test' },
    );

    expect(result).toHaveProperty('chat');
    expect(result).toHaveProperty('client');
    expect(result).toHaveProperty('reloadPersonality');
    expect(result).toHaveProperty('clearHistory');
  });

  it('chat is an async function', () => {
    const { chat } = createClaude(
      { apiKey: 'sk-test' },
      { personality: {}, memory: null, userDir: '/tmp/obol-test' },
    );

    expect(chat).toBeTypeOf('function');
  });

  it('clearHistory is a function', () => {
    const { clearHistory } = createClaude(
      { apiKey: 'sk-test' },
      { personality: {}, memory: null, userDir: '/tmp/obol-test' },
    );

    expect(clearHistory).toBeTypeOf('function');
  });

  it('reloadPersonality is a function', () => {
    const { reloadPersonality } = createClaude(
      { apiKey: 'sk-test' },
      { personality: {}, memory: null, userDir: '/tmp/obol-test' },
    );

    expect(reloadPersonality).toBeTypeOf('function');
  });

  it('client is an Anthropic instance with messages.create', () => {
    const { client } = createClaude(
      { apiKey: 'sk-test' },
      { personality: {}, memory: null, userDir: '/tmp/obol-test' },
    );

    expect(client).toBeInstanceOf(Anthropic);
    expect(client.messages.create).toBeTypeOf('function');
  });

  it('chat calls the API and returns text response', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Hello from Claude' }],
      stop_reason: 'end_turn',
    });

    const { chat, client } = createClaude(
      { apiKey: 'sk-test' },
      { personality: {}, memory: null, userDir: '/tmp/obol-test' },
    );
    stubClient(client, createSpy);

    const reply = await chat('Hi there');

    expect(createSpy).toHaveBeenCalled();
    expect(reply).toBe('Hello from Claude');
  });

  it('chat accumulates history across calls', async () => {
    const createSpy = vi.fn()
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'First reply' }],
        stop_reason: 'end_turn',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Second reply' }],
        stop_reason: 'end_turn',
      });

    const { chat, client } = createClaude(
      { apiKey: 'sk-test' },
      { personality: {}, memory: null, userDir: '/tmp/obol-test' },
    );
    stubClient(client, createSpy);

    await chat('First message');
    await chat('Second message');

    const lastCall = createSpy.mock.calls.at(-1)[0];
    expect(lastCall.messages.length).toBe(4);
  });

  it('clearHistory resets conversation for a specific chatId', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'reply' }],
      stop_reason: 'end_turn',
    });

    const { chat, client, clearHistory } = createClaude(
      { apiKey: 'sk-test' },
      { personality: {}, memory: null, userDir: '/tmp/obol-test' },
    );
    stubClient(client, createSpy);

    await chat('msg', { chatId: 'session-1' });
    clearHistory('session-1');
    await chat('fresh start', { chatId: 'session-1' });

    const lastCall = createSpy.mock.calls.at(-1)[0];
    expect(lastCall.messages[0].content).toBe('fresh start');
    expect(lastCall.messages[0].role).toBe('user');
  });

  it('clearHistory with no chatId clears all histories', async () => {
    const createSpy = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'reply' }],
      stop_reason: 'end_turn',
    });

    const { chat, client, clearHistory } = createClaude(
      { apiKey: 'sk-test' },
      { personality: {}, memory: null, userDir: '/tmp/obol-test' },
    );
    stubClient(client, createSpy);

    await chat('msg1', { chatId: 'a' });
    await chat('msg2', { chatId: 'b' });
    clearHistory();
    await chat('fresh', { chatId: 'a' });

    const lastCall = createSpy.mock.calls.at(-1)[0];
    expect(lastCall.messages[0].content).toBe('fresh');
    expect(lastCall.messages[0].role).toBe('user');
  });
});
