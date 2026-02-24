/**
 * Background task runner with progress check-ins.
 * 
 * Main conversation stays responsive. Heavy tasks run in background.
 * Claude periodically reports progress back to the user.
 */

const CHECK_IN_INTERVAL = 30000;
const MAX_CONCURRENT_TASKS = 3;

class BackgroundRunner {
  constructor() {
    this.tasks = new Map(); // taskId -> { promise, status, progress, chatId }
    this.taskCounter = 0;
  }

  /**
   * Spawn a background task. Returns immediately.
   * @param {object} claude - Claude client
   * @param {string} task - The task description
   * @param {object} ctx - Telegram context (for sending updates)
   * @param {object} memory - Memory instance
   * @param {object} parentContext - Parent context for verbose forwarding
   */
  spawn(claude, task, ctx, memory, parentContext) {
    let running = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') running++;
    }
    if (running >= MAX_CONCURRENT_TASKS) return null;

    const taskId = ++this.taskCounter;
    const chatId = ctx.chat.id;

    const taskState = {
      id: taskId,
      task,
      chatId,
      status: 'running',
      progress: [],
      startedAt: Date.now(),
    };

    this.tasks.set(taskId, taskState);

    const verbose = parentContext?.verbose || false;
    const verboseNotify = parentContext?._verboseNotify;

    // Start check-in timer before running task to avoid leak if task throws immediately
    taskState.checkInTimer = setInterval(async () => {
      if (taskState.status !== 'running') {
        clearInterval(taskState.checkInTimer);
        taskState.checkInTimer = null;
        return;
      }

      const elapsed = Math.floor((Date.now() - taskState.startedAt) / 1000);
      await this._checkIn(claude, taskState, ctx, elapsed);
    }, CHECK_IN_INTERVAL);

    // Run the task
    const promise = this._runTask(claude, task, taskState, ctx, memory, verbose, verboseNotify);
    taskState.promise = promise;

    return taskId;
  }

  async _runTask(claude, task, taskState, ctx, memory, verbose, verboseNotify) {
    try {
      // Give the background task a system instruction to report progress
      const bgPrompt = `You are working on a background task. Do the work thoroughly.

After EVERY tool call, update your internal progress by including a brief status line like:
"[PROGRESS] Searched 5 dental clinics, now checking reviews..."

This helps track what you're doing. Complete the full task, then give the final result.

TASK: ${task}`;

      const bgNotify = verboseNotify ? (msg) => verboseNotify(`[bg#${taskState.id}] ${msg}`) : undefined;
      const result = await claude.chat(bgPrompt, {
        chatId: `bg-${taskState.id}`,
        userName: 'BackgroundTask',
        verbose,
        _verboseNotify: bgNotify,
      });

      taskState.status = 'done';
      taskState.result = result;
      if (taskState.checkInTimer) { clearInterval(taskState.checkInTimer); taskState.checkInTimer = null; }
      claude.clearHistory(`bg-${taskState.id}`);

      // Send final result
      const elapsed = Math.floor((Date.now() - taskState.startedAt) / 1000);
      const header = `✅ Done! (${formatDuration(elapsed)})\n\n`;

      await sendLong(ctx, header + result);

      // Store to memory
      if (memory) {
        await memory.add(`Background task completed: "${task.substring(0, 100)}". Took ${elapsed}s.`, {
          category: 'context',
          source: 'background-task',
        }).catch(() => {});
      }

      // Cleanup after 5 min
      setTimeout(() => this.tasks.delete(taskState.id), 300000);

    } catch (e) {
      taskState.status = 'error';
      taskState.error = e.message;
      if (taskState.checkInTimer) { clearInterval(taskState.checkInTimer); taskState.checkInTimer = null; }

      await ctx.reply(`⚠️ Background task failed: ${e.message}`).catch(() => {});
    }
  }

  async _checkIn(claude, taskState, ctx, elapsed) {
    try {
      // Ask Claude for a brief status update based on what it's been doing
      const checkInPrompt = `You have a background task running for ${elapsed}s: "${taskState.task}"

Give a ONE LINE progress update (emoji + what's happening). Be specific about what you've found/done so far. Example: "⏳ Found 8 clinics, comparing ratings and prices..."`;

      // Use a separate quick call — don't interfere with the main task
      const checkInChatId = `checkin-${taskState.id}`;
      const update = await claude.chat(checkInPrompt, {
        chatId: checkInChatId,
        userName: 'CheckIn',
      });

      if (update && update.trim()) {
        await ctx.reply(update.trim()).catch(() => {});
      }

      claude.clearHistory(checkInChatId);
    } catch {
      // Check-in failed — not critical, skip it
    }
  }

  /**
   * Get status of all running tasks
   */
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

  /**
   * Check if there are running tasks
   */
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
  if (text.length <= 4096) {
    await ctx.reply(text, { parse_mode: 'Markdown' }).catch(() =>
      ctx.reply(text)
    );
    return;
  }

  // Split on newlines
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 4096) {
      await ctx.reply(remaining, { parse_mode: 'Markdown' }).catch(() =>
        ctx.reply(remaining)
      );
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', 4096);
    if (splitAt === -1 || splitAt < 2000) splitAt = 4096;
    const chunk = remaining.substring(0, splitAt);
    await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() =>
      ctx.reply(chunk)
    );
    remaining = remaining.substring(splitAt).trimStart();
  }
}

module.exports = { BackgroundRunner };
