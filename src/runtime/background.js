const { buildStatusHtml, formatToolCall } = require('../status');
const { markdownToTelegramHtml } = require('../telegram/utils');

const MAX_CONCURRENT_TASKS = 3;

class BackgroundRunner {
  constructor() {
    this.tasks = new Map();
    this.taskCounter = 0;
  }

  spawn(claude, task, ctx, memory, parentContext, opts = {}, extraContext = {}) {
    let running = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') running++;
    }
    if (running >= MAX_CONCURRENT_TASKS) return null;

    const taskId = ++this.taskCounter;

    const taskState = {
      id: taskId,
      task,
      chatId: ctx.chat.id,
      status: 'running',
      startedAt: Date.now(),
    };

    this.tasks.set(taskId, taskState);

    const verbose = parentContext?.verbose || false;
    const verboseNotify = parentContext?._verboseNotify;

    const inherited = parentContext ? {
      toolPrefs: parentContext.toolPrefs,
      config: parentContext.config,
      scheduler: parentContext.scheduler,
      messageLog: parentContext.messageLog,
      userId: parentContext.userId,
      userDir: parentContext.userDir,
      telegramAsk: parentContext.telegramAsk,
      _notifyFn: parentContext._notifyFn,
    } : {};

    const mergedExtra = { ...inherited, ...(opts.extraContext || extraContext) };

    const promise = this._runTask(claude, task, taskState, ctx, memory, verbose, verboseNotify, opts.model, mergedExtra, opts.silent || false);
    taskState.promise = promise;

    return taskId;
  }

  async _runTask(claude, task, taskState, ctx, memory, verbose, verboseNotify, model, extraContext = {}, silent = false) {
    let statusMsgId = null;
    let statusTimer = null;
    let statusStart = Date.now();
    let statusText = 'Starting';
    let routeInfo = null;
    const title = `BG #${taskState.id}`;

    const clearStatus = () => {
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      if (statusMsgId) { ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => {}); statusMsgId = null; }
    };

    const startStatusTimer = () => {
      if (silent || statusTimer) return;
      const html = buildStatusHtml({ route: routeInfo, elapsed: 0, toolStatus: statusText, title });
      ctx.reply(html, { parse_mode: 'HTML' }).then(sent => {
        if (sent) statusMsgId = sent.message_id;
      }).catch(() => {});
      statusTimer = setInterval(() => {
        if (!statusMsgId) return;
        const elapsed = Math.round((Date.now() - statusStart) / 1000);
        const html = buildStatusHtml({ route: routeInfo, elapsed, toolStatus: statusText, title });
        ctx.api.editMessageText(ctx.chat.id, statusMsgId, html, { parse_mode: 'HTML' }).catch(() => {});
      }, 5000);
    };

    if (!silent) startStatusTimer();

    try {
      const bgPrompt = `You are working on a background task. Do the work thoroughly.
Complete the full task, then give the final result.

TASK: ${task}`;

      const bgNotify = verboseNotify ? (msg) => verboseNotify(`[bg#${taskState.id}] ${msg}`) : undefined;
      const { text: result } = await claude.chat(bgPrompt, {
        ...extraContext,
        chatId: `bg-${taskState.id}`,
        userName: 'BackgroundTask',
        verbose,
        ...(model ? { _model: model } : {}),
        _verboseNotify: bgNotify,
        _onRouteDecision: (info) => {
          routeInfo = info;
        },
        _onRouteUpdate: (update) => {
          if (!routeInfo) return;
          if (update.memoryCount !== undefined) routeInfo.memoryCount = update.memoryCount;
          if (update.model) routeInfo.model = update.model;
        },
        _onToolStart: (toolName, inputSummary) => {
          statusText = formatToolCall(toolName, inputSummary) || 'Processing';
          startStatusTimer();
        },
      });

      claude.clearHistory(`bg-${taskState.id}`);
      clearStatus();

      if (!result?.trim()) {
        taskState.status = 'error';
        taskState.error = 'No result returned';
        if (!silent) {
          await ctx.reply(`⚠️ BG #${taskState.id} finished but produced no result.`).catch(() => {});
        }
      } else {
        taskState.status = 'done';
        taskState.result = result;
        const elapsed = Math.floor((Date.now() - taskState.startedAt) / 1000);
        if (silent) {
          await sendLong(ctx, result);
        } else {
          const header = `✅ <b>BG #${taskState.id}</b> done (${formatDuration(elapsed)})\n\n`;
          await sendLong(ctx, header + result);
        }
      }

      if (memory) {
        await memory.add(`Background task completed: "${task.substring(0, 100)}". Took ${elapsed}s.`, {
          category: 'context',
          source: 'background-task',
        }).catch(() => {});
      }

      setTimeout(() => this.tasks.delete(taskState.id), 300000);

    } catch (e) {
      taskState.status = 'error';
      taskState.error = e.message;
      clearStatus();
      if (!silent) {
        await ctx.reply(`⚠️ BG #${taskState.id} failed: ${e.message}`).catch(() => {});
      } else {
        console.error(`[bg#${taskState.id}] Silent task failed: ${e.message}`);
      }
    }
  }

  getStatus() {
    const running = [];
    for (const [id, task] of this.tasks) {
      if (task.status === 'running') {
        const elapsed = Math.floor((Date.now() - task.startedAt) / 1000);
        running.push({
          id,
          task: task.task.substring(0, 80),
          elapsed: formatDuration(elapsed),
        });
      }
    }
    return running;
  }

  hasRunningTasks() {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') return true;
    }
    return false;
  }
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

async function sendLong(ctx, text) {
  if (!text?.trim()) return;
  const html = markdownToTelegramHtml(text);
  if (html.length <= 4096) {
    await ctx.reply(html, { parse_mode: 'HTML' }).catch(() => ctx.reply(text));
    return;
  }

  let remaining = html;
  while (remaining.length > 0) {
    if (remaining.length <= 4096) {
      await ctx.reply(remaining, { parse_mode: 'HTML' }).catch(() => ctx.reply(remaining));
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', 4096);
    if (splitAt === -1 || splitAt < 2000) splitAt = 4096;
    const chunk = remaining.substring(0, splitAt);
    await ctx.reply(chunk, { parse_mode: 'HTML' }).catch(() => ctx.reply(chunk));
    remaining = remaining.substring(splitAt).trimStart();
  }
}

module.exports = { BackgroundRunner };
