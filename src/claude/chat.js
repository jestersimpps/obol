const path = require('path');
const { OBOL_DIR } = require('../config');
const { ChatHistory } = require('../history');
const { createAnthropicClient, ensureFreshToken } = require('./client');
const { routeMessage } = require('./router');
const { buildSystemPrompt, buildSystemBlock, buildRuntimePrefix, withRuntimeContext } = require('./prompt');
const { buildTools, buildRunnableTools, addToolCache } = require('./tool-registry');
const { withCacheBreakpoints, sanitizeMessages, stripToolBlocks } = require('./cache');
const { getMaxToolIterations } = require('./constants');

function createClaude(anthropicConfig, { personality, memory, selfMemory, patterns, userDir = OBOL_DIR, bridgeEnabled, botName }) {
  let client = createAnthropicClient(anthropicConfig);

  let baseSystemPrompt = buildSystemPrompt(personality, userDir, { bridgeEnabled, botName });

  const histories = new ChatHistory(50);
  const chatLocks = new Map();
  const chatAbortControllers = new Map();
  const chatForceControllers = new Map();

  const tools = buildTools(memory, { bridgeEnabled, selfMemory, patterns });

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
        selfMemory,
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
    const systemPrompt = buildSystemBlock(baseSystemPrompt);
    context._reloadPersonality = reloadPersonality;
    context._abortSignal = abortController.signal;
    context._forceSignal = forceController.signal;
    context.claude = { chat, clearHistory, client };
    context.selfMemory = selfMemory;
    context.patterns = patterns;
    const runnableTools = buildRunnableTools(tools, memory, context, vlog);
    let activeModel = model;

    const ttsEnabled = context.toolPrefs?.get('text_to_speech')?.enabled;
    const runtimePrefix = buildRuntimePrefix(chatId, { ttsEnabled, memoryBlock });

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

    if (activeModel.includes('haiku')) {
      const haikuMessages = withCacheBreakpoints(withRuntimeContext(stripToolBlocks([...history]), runtimePrefix));
      context._onPromptReady?.({ system: systemPrompt, messages: haikuMessages, model: activeModel, tools: [] });

      const haikuResponse = await client.messages.create({
        model: activeModel,
        max_tokens: 4096,
        system: systemPrompt,
        messages: haikuMessages,
      }, { signal: abortController.signal });

      trackUsage(haikuResponse.usage);
      histories.pushAssistant(chatId, haikuResponse.content);
      const text = haikuResponse.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { text, usage: totalUsage, model: activeModel };
    }

    const cachedTools = runnableTools.length > 0 ? addToolCache(runnableTools) : undefined;

    const assembledMessages = withCacheBreakpoints(withRuntimeContext([...history], runtimePrefix));
    context._onPromptReady?.({ system: systemPrompt, messages: assembledMessages, model: activeModel, tools: cachedTools });

    const runner = client.beta.messages.toolRunner({
      model: activeModel,
      max_tokens: 128000,
      system: systemPrompt,
      messages: assembledMessages,
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
    const { PERSONALITY_DIR } = require('../soul');
    const pDir = userDir ? path.join(userDir, 'personality') : undefined;
    const newPersonality = require('../soul/personality').loadPersonality(PERSONALITY_DIR, pDir);
    for (const key of Object.keys(personality)) delete personality[key];
    Object.assign(personality, newPersonality);
    baseSystemPrompt = buildSystemPrompt(personality, userDir, { bridgeEnabled, botName });
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

  function repairHistory(chatId) {
    histories.repair(chatId || 'default');
  }

  return { chat, client, reloadPersonality, clearHistory, injectHistory, repairHistory, getContextStats, stopChat, forceStopChat };
}

module.exports = { createClaude };
