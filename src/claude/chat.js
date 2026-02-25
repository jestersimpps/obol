const path = require('path');
const { OBOL_DIR } = require('../config');
const { ChatHistory } = require('../history');
const { createAnthropicClient, ensureFreshToken } = require('./client');
const { routeMessage } = require('./router');
const { buildSystemPrompt } = require('./prompt');
const { buildTools, buildRunnableTools } = require('./tool-registry');
const { withCacheBreakpoints } = require('./cache');
const { getMaxToolIterations } = require('./constants');

function createClaude(anthropicConfig, { personality, memory, userDir = OBOL_DIR, bridgeEnabled }) {
  let client = createAnthropicClient(anthropicConfig);

  let baseSystemPrompt = buildSystemPrompt(personality, userDir, { bridgeEnabled });

  const histories = new ChatHistory(50);
  const chatLocks = new Map();
  const chatAbortControllers = new Map();

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
    chatAbortControllers.set(chatId, abortController);

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
      { type: 'text', text: `\nCurrent time: ${new Date().toISOString()}${memoryBlock ? `\n\n${memoryBlock}` : ''}` },
    ];
    context._reloadPersonality = reloadPersonality;
    const runnableTools = buildRunnableTools(tools, memory, context, vlog);

    const runner = client.beta.messages.toolRunner({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: withCacheBreakpoints([...history]),
      tools: runnableTools.length > 0 ? runnableTools : undefined,
      max_iterations: getMaxToolIterations(),
    }, { signal: abortController.signal });

    let finalMessage;
    let totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    for await (const message of runner) {
      finalMessage = message;
      if (message.usage) {
        totalUsage.input_tokens += message.usage.input_tokens || 0;
        totalUsage.output_tokens += message.usage.output_tokens || 0;
        totalUsage.cache_creation_input_tokens += message.usage.cache_creation_input_tokens || 0;
        totalUsage.cache_read_input_tokens += message.usage.cache_read_input_tokens || 0;
        const cacheInfo = (message.usage.cache_read_input_tokens || message.usage.cache_creation_input_tokens)
          ? ` cache_read=${message.usage.cache_read_input_tokens || 0} cache_create=${message.usage.cache_creation_input_tokens || 0}`
          : '';
        vlog(`[tokens] in=${message.usage.input_tokens} out=${message.usage.output_tokens}${cacheInfo}`);
      }
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
      const bailoutResponse = await client.messages.create({
        model, max_tokens: 4096, system: systemPrompt, messages: withCacheBreakpoints([...histories.get(chatId)]),
      }, { signal: abortController.signal });
      histories.pushAssistant(chatId, bailoutResponse.content);
      if (bailoutResponse.usage) {
        totalUsage.input_tokens += bailoutResponse.usage.input_tokens || 0;
        totalUsage.output_tokens += bailoutResponse.usage.output_tokens || 0;
      }
      const text = bailoutResponse.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { text, usage: totalUsage, model };
    }

    let text = finalMessage.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

    if (!text.trim() && newMessages.length > 1) {
      vlog('[claude] No text in final response after tool use — forcing summary');
      histories.pushUser(chatId, 'Provide a concise response to the user based on the tool results above.');
      const summaryResponse = await client.messages.create({
        model, max_tokens: 4096, system: systemPrompt, messages: withCacheBreakpoints([...histories.get(chatId)]),
      }, { signal: abortController.signal });
      histories.pushAssistant(chatId, summaryResponse.content);
      if (summaryResponse.usage) {
        totalUsage.input_tokens += summaryResponse.usage.input_tokens || 0;
        totalUsage.output_tokens += summaryResponse.usage.output_tokens || 0;
      }
      text = summaryResponse.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }

    return { text, usage: totalUsage, model };

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
      chatAbortControllers.delete(chatId);
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

  return { chat, client, reloadPersonality, clearHistory, injectHistory, getContextStats, stopChat };
}

module.exports = { createClaude };
