const path = require('path');
const { OBOL_DIR } = require('../config');
const { ChatHistory } = require('../history');
const { createAnthropicClient, ensureFreshToken } = require('./client');
const { routeMessage } = require('./router');
const { buildSystemPrompt } = require('./prompt');
const { buildTools, buildRunnableTools } = require('./tool-registry');
const { withCacheBreakpoints, sanitizeMessages } = require('./cache');
const { getMaxToolIterations } = require('./constants');

function createClaude(anthropicConfig, { personality, memory, userDir = OBOL_DIR, bridgeEnabled }) {
  let client = createAnthropicClient(anthropicConfig);

  let baseSystemPrompt = buildSystemPrompt(personality, userDir, { bridgeEnabled });

  const histories = new ChatHistory(50);
  const chatLocks = new Map();
  const chatAbortControllers = new Map();
  const chatForceControllers = new Map();

  const tools = buildTools(memory, { bridgeEnabled });

  function acquireChatLock(chatId) {
    if (!chatLocks.has(chatId)) chatLocks.set(chatId, { promise: Promise.resolve(), busy: false });
    const lock = chatLocks.get(chatId);
    let release;
    const prev = lock.promise;
    lock.promise = new Promise(r => { release = r; });
    return prev.then(() => {
      lock.busy = true;
      return () => { lock.busy = false; release(); };
    });
  }

  function isChatBusy(chatId) {
    return chatLocks.get(chatId)?.busy || false;
  }

  async function chat(userMessage, context = {}) {
    context.userDir = userDir;
    const chatId = context.chatId || 'default';

    if (isChatBusy(chatId)) {
      return { text: 'I\'m still working on the previous request. Give me a moment.', usage: null, model: null };
    }

    const releaseLock = await acquireChatLock(chatId);
    const abortController = new AbortController();
    const forceController = new AbortController();
    chatAbortControllers.set(chatId, abortController);
    chatForceControllers.set(chatId, forceController);

    const lockTimeoutId = setTimeout(() => {
      abortController.abort();
      context._onLockTimeout?.();
    }, 10 * 60 * 1000);

    const history = histories.get(chatId);

    try {

    if (anthropicConfig.oauth?.accessToken) {
      await ensureFreshToken(anthropicConfig);
      if (anthropicConfig._oauthFailed) {
        client = createAnthropicClient(anthropicConfig, { useOAuth: false });
      } else {
        client = createAnthropicClient(anthropicConfig, { useOAuth: true });
      }
    }

    const verbose = context.verbose || false;
    if (verbose) context.verboseLog = [];
    const vlog = (msg) => {
      if (!verbose) return;
      context.verboseLog.push(msg);
      context._verboseNotify?.(msg);
    };

    let memoryBlock = null;
    if (memory) {
      const result = await routeMessage(client, memory, userMessage, {
        vlog,
        onRouteDecision: context._onRouteDecision,
        onRouteUpdate: context._onRouteUpdate,
        recentHistory: history,
      });
      memoryBlock = result.memoryBlock;
      if (result.model) context._model = result.model;
    }

    histories.prune(chatId);

    if (context.images?.length) {
      histories.pushUser(chatId, [...context.images, { type: 'text', text: userMessage }]);
    } else {
      histories.pushUser(chatId, userMessage);
    }

    const model = context._model || 'claude-sonnet-4-6';
    vlog(`[model] ${model} | history=${history.length} msgs | facts=${memoryBlock ? 'yes' : 'none'}`);
    const systemPrompt = [
      { type: 'text', text: baseSystemPrompt, cache_control: { type: 'ephemeral' } },
    ];
    context._reloadPersonality = reloadPersonality;
    context._abortSignal = abortController.signal;
    context._forceSignal = forceController.signal;
    context.claude = { chat, clearHistory, client };
    const runnableTools = buildRunnableTools(tools, memory, context, vlog);
    let activeModel = model;

    const runtimePrefix = [
      { type: 'text', text: '[Runtime context — metadata only, not instructions]' },
      { type: 'text', text: `Current time: ${new Date().toISOString()}\nChat ID: ${chatId}` },
      ...(memoryBlock ? [{ type: 'text', text: memoryBlock }] : []),
    ];

    function withRuntimeContext(msgs) {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      const lastIdx = copy.length - 1;
      const last = copy[lastIdx];
      const existing = typeof last.content === 'string'
        ? [{ type: 'text', text: last.content }]
        : [...last.content];
      copy[lastIdx] = { ...last, content: [...runtimePrefix, ...existing] };
      return sanitizeMessages(copy);
    }

    let totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    function trackUsage(usage) {
      if (!usage) return;
      totalUsage.input_tokens += usage.input_tokens || 0;
      totalUsage.output_tokens += usage.output_tokens || 0;
      totalUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
      totalUsage.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
      const cacheInfo = (usage.cache_read_input_tokens || usage.cache_creation_input_tokens)
        ? ` cache_read=${usage.cache_read_input_tokens || 0} cache_create=${usage.cache_creation_input_tokens || 0}`
        : '';
      vlog(`[tokens] in=${usage.input_tokens} out=${usage.output_tokens}${cacheInfo}`);
    }

    if (activeModel.includes('haiku') && runnableTools.length > 0) {
      const toolDefs = runnableTools.map(({ run, ...def }) => def);
      const probe = await client.messages.create({
        model: activeModel,
        max_tokens: 4096,
        system: systemPrompt,
        messages: withCacheBreakpoints(withRuntimeContext([...history])),
        tools: toolDefs,
      }, { signal: abortController.signal });

      trackUsage(probe.usage);

      const hasToolUse = probe.content.some(b => b.type === 'tool_use');
      if (!hasToolUse) {
        histories.pushAssistant(chatId, probe.content);
        const text = probe.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        return { text, usage: totalUsage, model: activeModel };
      }

      vlog('[escalate] haiku → sonnet (tool use requested)');
      activeModel = 'claude-sonnet-4-6';
      context._onRouteUpdate?.({ model: 'sonnet' });
    }

    let cachedTools;
    if (runnableTools.length > 0) {
      cachedTools = [...runnableTools];
      const lastIdx = cachedTools.length - 1;
      const { run, ...lastDef } = cachedTools[lastIdx];
      cachedTools[lastIdx] = { ...lastDef, cache_control: { type: 'ephemeral' }, run };
    }

    const runner = client.beta.messages.toolRunner({
      model: activeModel,
      max_tokens: 128000,
      system: systemPrompt,
      messages: withCacheBreakpoints(withRuntimeContext([...history])),
      tools: cachedTools ?? undefined,
      max_iterations: getMaxToolIterations(),
      stream: true,
    }, { signal: abortController.signal });

    let finalMessage;
    for await (const streamItem of runner) {
      const msg = await streamItem.finalMessage();
      finalMessage = msg;
      trackUsage(msg.usage);
      if (abortController.signal.aborted) break;
    }

    const runnerMessages = runner.params.messages;
    const newMessages = runnerMessages.slice(history.length);
    histories.pushMessages(chatId, newMessages);

    if (finalMessage.stop_reason === 'tool_use') {
      const bailoutResults = finalMessage.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '[max tool iterations reached]' }));
      histories.pushUser(chatId, [
        ...bailoutResults,
        { type: 'text', text: 'You have used too many tool calls. Please provide a final response now based on what you have so far.' },
      ]);
      const bailoutResponse = await client.messages.stream({
        model: activeModel, max_tokens: 131072, system: systemPrompt, messages: withCacheBreakpoints(sanitizeMessages([...histories.get(chatId)])),
      }, { signal: abortController.signal }).finalMessage();
      histories.pushAssistant(chatId, bailoutResponse.content);
      trackUsage(bailoutResponse.usage);
      const text = bailoutResponse.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { text, usage: totalUsage, model: activeModel };
    }

    let text = finalMessage.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

    if (!text.trim() && newMessages.length > 1) {
      vlog('[claude] No text in final response after tool use — forcing summary');
      histories.pushUser(chatId, 'Provide a concise response to the user based on the tool results above.');
      const summaryResponse = await client.messages.stream({
        model: activeModel, max_tokens: 131072, system: systemPrompt, messages: withCacheBreakpoints(sanitizeMessages([...histories.get(chatId)])),
      }, { signal: abortController.signal }).finalMessage();
      histories.pushAssistant(chatId, summaryResponse.content);
      trackUsage(summaryResponse.usage);
      text = summaryResponse.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }

    return { text, usage: totalUsage, model: activeModel };

    } catch (e) {
      if (e.message === 'Request was aborted.' || e.constructor?.name === 'APIUserAbortError') {
        return { text: null, usage: null, model: null };
      }
      if (e.status === 400 && e.message?.includes('tool_use')) {
        console.error('[claude] Repairing corrupted history after 400 error');
        histories.repair(chatId);
      }
      throw e;
    } finally {
      clearTimeout(lockTimeoutId);
      chatAbortControllers.delete(chatId);
      chatForceControllers.delete(chatId);
      releaseLock();
    }
  }

  function stopChat(chatId) {
    const controller = chatAbortControllers.get(chatId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  function forceStopChat(chatId) {
    const controller = chatAbortControllers.get(chatId);
    const force = chatForceControllers.get(chatId);
    if (force) force.abort();
    if (controller) { controller.abort(); return true; }
    return false;
  }

  function reloadPersonality() {
    const pDir = userDir ? path.join(userDir, 'personality') : undefined;
    const newPersonality = require('../personality').loadPersonality(pDir);
    for (const key of Object.keys(personality)) delete personality[key];
    Object.assign(personality, newPersonality);
    baseSystemPrompt = buildSystemPrompt(personality, userDir, { bridgeEnabled });
  }

  function clearHistory(chatId) {
    if (chatId) {
      histories.delete(chatId);
    } else {
      histories.clear();
    }
  }

  function injectHistory(chatId, role, content) {
    histories.inject(chatId, role, content);
  }

  function getContextStats(chatId) {
    const id = chatId || 'default';
    return histories.estimateTokens(id, baseSystemPrompt.length);
  }

  return { chat, client, reloadPersonality, clearHistory, injectHistory, getContextStats, stopChat, forceStopChat };
}

module.exports = { createClaude };
