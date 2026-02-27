const { OPTIONAL_TOOLS } = require('./constants');

const execTool = require('./tools/exec');
const memoryTool = require('./tools/memory');
const knowledgeTool = require('./tools/knowledge');
const webTool = require('./tools/web');
const filesTool = require('./tools/files');
const secretsTool = require('./tools/secrets');
const backgroundTool = require('./tools/background');
const telegramTool = require('./tools/telegram');
const schedulerTool = require('./tools/scheduler');
const ttsTool = require('./tools/tts');
const bridgeTool = require('./tools/bridge');
const historyTool = require('./tools/history');
const agentTool = require('./tools/agent');
const sttTool = require('./tools/stt');
const mermaidTool = require('./tools/mermaid');
const personalityTool = require('./tools/personality');

const TOOL_MODULES = [
  execTool,
  webTool,
  filesTool,
  secretsTool,
  backgroundTool,
  telegramTool,
  schedulerTool,
  ttsTool,
  historyTool,
  agentTool,
  sttTool,
  mermaidTool,
  personalityTool,
];

const INPUT_SUMMARIES = {
  exec: (i) => i.command,
  write_file: (i) => i.path,
  read_file: (i) => i.offset ? `${i.path}:${i.offset}` : i.path,
  edit_file: (i) => i.path,
  glob: (i) => i.pattern,
  grep: (i) => `${i.pattern}${i.path ? ` in ${i.path}` : ''}`,
  memory_search: (i) => i.query,
  memory_add: (i) => `[${i.category || 'fact'}]`,
  memory_remove: (i) => i.ids?.join(', '),
  memory_query: (i) => `${i.date || ''}${i.tags ? ' #' + i.tags.join(' #') : ''}${i.category ? ' [' + i.category + ']' : ''}`.trim() || 'all',
  knowledge_add: (i) => `[${i.category}]`,
  knowledge_search: (i) => i.query,
  interests_list: () => 'interests',
  interests_add: (i) => i.content?.substring(0, 60),
  web_search: (i) => i.query,
  agent: (i) => i.task?.substring(0, 60),
  background_task: (i) => i.task?.substring(0, 60),
  schedule_event: (i) => `${i.title} @ ${i.due_at}${i.cron_expr ? ` [${i.cron_expr}]` : ''}`,
  cancel_event: (i) => i.event_id,
  create_pdf: (i) => i.filename || 'document',
  text_to_speech: (i) => i.text?.substring(0, 60),
  tts_voices: (i) => i.language || 'all',
  chat_history: (i) => `${i.date}${i.role ? ` [${i.role}]` : ''}`,
  propose_personality_edit: (i) => `${i.file}${i.section ? `: ${i.section}` : ''}`,
};

function summarizeInput(toolName, input) {
  const fn = INPUT_SUMMARIES[toolName];
  return fn ? fn(input) : JSON.stringify(input).substring(0, 80);
}

function buildTools(memory, opts = {}) {
  const tools = [];

  for (const mod of TOOL_MODULES) {
    tools.push(...mod.definitions);
  }

  if (memory) {
    tools.push(...memoryTool.definitions);
  }

  if (opts.selfMemory) {
    tools.push(...knowledgeTool.definitions);
  }

  if (opts.bridgeEnabled) {
    tools.push(...bridgeTool.getDefinitions());
  }

  return tools;
}

function buildHandlerMap() {
  const map = {};
  for (const mod of TOOL_MODULES) {
    Object.assign(map, mod.handlers);
  }
  Object.assign(map, memoryTool.handlers);
  Object.assign(map, knowledgeTool.handlers);
  Object.assign(map, bridgeTool.handlers);
  return map;
}

const _handlers = buildHandlerMap();

function buildRunnableTools(tools, memory, context, vlog) {
  const disabledTools = new Set();
  const toolPrefs = context.toolPrefs;
  if (toolPrefs) {
    for (const [featureKey, feature] of Object.entries(OPTIONAL_TOOLS)) {
      const pref = toolPrefs.get(featureKey);
      if (!pref || !pref.enabled) {
        for (const t of feature.tools) disabledTools.add(t);
      }
    }
  }

  return tools
    .filter(tool => !disabledTools.has(tool.name))
    .map(tool => ({
      ...tool,
      run: async (input) => {
        const signal = context._abortSignal;
        const forceSignal = context._forceSignal;
        if (signal?.aborted) return 'Aborted.';
        const inputSummary = summarizeInput(tool.name, input);
        vlog(`[tool] ${tool.name}: ${inputSummary}`);
        context._onToolStart?.(tool.name, inputSummary);

        const handler = _handlers[tool.name];
        if (!handler) return `Unknown tool: ${tool.name}`;

        try {
          if (!forceSignal) return await handler(input, memory, context);
          if (forceSignal.aborted) return 'Aborted.';
          const forcePromise = new Promise((resolve) => {
            forceSignal.addEventListener('abort', () => resolve('Aborted.'), { once: true });
          });
          return await Promise.race([handler(input, memory, context), forcePromise]);
        } catch (e) {
          if (signal?.aborted || forceSignal?.aborted) return 'Aborted.';
          return `Error: ${e.message}`;
        }
      },
    }));
}

module.exports = { buildTools, buildRunnableTools, OPTIONAL_TOOLS, summarizeInput };
