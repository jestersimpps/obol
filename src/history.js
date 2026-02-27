const MAX_CONTEXT = 200000;

function parseTurns(messages) {
  const turns = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'user') {
      const hasToolResult = Array.isArray(msg.content) &&
        msg.content.some(b => b.type === 'tool_result');

      if (hasToolResult) {
        i++;
        continue;
      }

      const turnMessages = [msg];
      i++;

      if (i < messages.length && messages[i].role === 'assistant') {
        const assistantMsg = messages[i];
        turnMessages.push(assistantMsg);
        i++;

        const hasToolUse = Array.isArray(assistantMsg.content) &&
          assistantMsg.content.some(b => b.type === 'tool_use');

        if (hasToolUse) {
          while (i < messages.length) {
            const next = messages[i];
            if (next.role === 'user' && Array.isArray(next.content) &&
                next.content.some(b => b.type === 'tool_result')) {
              turnMessages.push(next);
              i++;

              if (i < messages.length && messages[i].role === 'assistant') {
                const nextAssistant = messages[i];
                turnMessages.push(nextAssistant);
                i++;

                const nextHasToolUse = Array.isArray(nextAssistant.content) &&
                  nextAssistant.content.some(b => b.type === 'tool_use');
                if (!nextHasToolUse) break;
              } else {
                break;
              }
            } else {
              break;
            }
          }
        }
      }

      turns.push(turnMessages);
    } else if (msg.role === 'assistant') {
      const turnMessages = [msg];
      i++;

      const hasToolUse = Array.isArray(msg.content) &&
        msg.content.some(b => b.type === 'tool_use');

      if (hasToolUse) {
        while (i < messages.length) {
          const next = messages[i];
          if (next.role === 'user' && Array.isArray(next.content) &&
              next.content.some(b => b.type === 'tool_result')) {
            turnMessages.push(next);
            i++;

            if (i < messages.length && messages[i].role === 'assistant') {
              const nextAssistant = messages[i];
              turnMessages.push(nextAssistant);
              i++;

              const nextHasToolUse = Array.isArray(nextAssistant.content) &&
                nextAssistant.content.some(b => b.type === 'tool_use');
              if (!nextHasToolUse) break;
            } else {
              break;
            }
          } else {
            break;
          }
        }
      }

      turns.push(turnMessages);
    } else {
      i++;
    }
  }

  return turns;
}

function validate(messages) {
  const errors = [];

  if (messages.length === 0) return { valid: true, errors };

  if (messages[0].role !== 'user') {
    errors.push('first message must be role=user');
  }

  if (messages[0].role === 'user' && Array.isArray(messages[0].content) &&
      messages[0].content.some(b => b.type === 'tool_result')) {
    errors.push('first message contains orphaned tool_result');
  }

  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role &&
        messages[i].role === 'user' &&
        !(Array.isArray(messages[i].content) && messages[i].content.some(b => b.type === 'tool_result'))) {
      errors.push(`consecutive user messages at index ${i - 1},${i}`);
    }
  }

  const allToolUseIds = new Set();
  const allToolResultIds = new Set();
  const duplicateToolResultIds = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use') allToolUseIds.add(b.id);
      }
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_result') {
          if (allToolResultIds.has(b.tool_use_id)) {
            duplicateToolResultIds.push(b.tool_use_id);
          }
          allToolResultIds.add(b.tool_use_id);
        }
      }
    }
  }

  for (const id of duplicateToolResultIds) {
    errors.push(`duplicate tool_result for tool_use_id=${id}`);
  }

  for (const id of allToolResultIds) {
    if (!allToolUseIds.has(id)) {
      errors.push(`orphaned tool_result for tool_use_id=${id}`);
    }
  }

  for (const id of allToolUseIds) {
    if (!allToolResultIds.has(id)) {
      errors.push(`missing tool_result for tool_use_id=${id}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function repair(messages) {
  const allToolUseIds = new Set();
  const allToolResultIds = new Set();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use') allToolUseIds.add(b.id);
      }
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_result') allToolResultIds.add(b.tool_use_id);
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    const toolResults = msg.content.filter(b => b.type === 'tool_result');
    if (toolResults.length === 0) continue;
    const orphaned = toolResults.filter(b => !allToolUseIds.has(b.tool_use_id));
    if (orphaned.length === 0) continue;
    const remaining = msg.content.filter(b =>
      b.type !== 'tool_result' || allToolUseIds.has(b.tool_use_id));
    if (remaining.length === 0) {
      messages.splice(i, 1);
    } else {
      msg.content = remaining;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const toolUseIds = msg.content.filter(b => b.type === 'tool_use').map(b => b.id);
    if (toolUseIds.length === 0) continue;
    const next = messages[i + 1];
    if (next?.role === 'user' && Array.isArray(next.content)) {
      const existingIds = new Set(
        next.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id));
      const missingIds = toolUseIds.filter(id => !existingIds.has(id) && !allToolResultIds.has(id));
      if (missingIds.length > 0) {
        next.content = [
          ...next.content,
          ...missingIds.map(id => ({
            type: 'tool_result', tool_use_id: id, content: '[interrupted]',
          })),
        ];
      }
    } else {
      const existingElsewhere = toolUseIds.filter(id => allToolResultIds.has(id));
      const trulyMissing = toolUseIds.filter(id => !allToolResultIds.has(id));
      if (trulyMissing.length > 0) {
        const fakeResults = trulyMissing.map(id => ({
          type: 'tool_result', tool_use_id: id, content: '[interrupted]',
        }));
        messages.splice(i + 1, 0, { role: 'user', content: fakeResults });
      }
    }
  }

  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === messages[i - 1].role && messages[i].role === 'user') {
      const prev = messages[i - 1];
      const curr = messages[i];
      const prevArr = Array.isArray(prev.content)
        ? prev.content : [{ type: 'text', text: prev.content }];
      const currArr = Array.isArray(curr.content)
        ? curr.content : [{ type: 'text', text: curr.content }];
      messages[i - 1] = { role: 'user', content: [...prevArr, ...currArr] };
      messages.splice(i, 1);
    }
  }

  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    const seen = new Set();
    msg.content = msg.content.filter(b => {
      if (b.type !== 'tool_result') return true;
      if (seen.has(b.tool_use_id)) return false;
      seen.add(b.tool_use_id);
      return true;
    });
  }
}

function stripCitations(content) {
  if (!Array.isArray(content)) return content;
  return content.map(b => {
    if (b.citations) {
      const { citations, ...rest } = b;
      return rest;
    }
    return b;
  });
}

class ChatHistory {
  constructor(maxMessages = 50) {
    this._store = new Map();
    this._maxMessages = maxMessages;
  }

  get(chatId) {
    if (!this._store.has(chatId)) this._store.set(chatId, []);
    return this._store.get(chatId);
  }

  has(chatId) {
    return this._store.has(chatId);
  }

  delete(chatId) {
    this._store.delete(chatId);
  }

  clear() {
    this._store.clear();
  }

  pushUser(chatId, content) {
    const history = this.get(chatId);
    history.push({ role: 'user', content });
    this._validateAndRepair(chatId);
  }

  pushAssistant(chatId, content) {
    const history = this.get(chatId);
    history.push({ role: 'assistant', content: stripCitations(content) });
    this._validateAndRepair(chatId);
  }

  pushMessages(chatId, msgs) {
    const history = this.get(chatId);
    for (const msg of msgs) {
      history.push(msg.role === 'assistant'
        ? { ...msg, content: stripCitations(msg.content) }
        : msg);
    }
    this._validateAndRepair(chatId);
  }

  inject(chatId, role, content) {
    const history = this.get(chatId);
    history.push({ role, content });
  }

  prune(chatId) {
    const history = this.get(chatId);
    if (history.length < this._maxMessages) return;

    const turns = parseTurns(history);
    while (flattenTurns(turns).length >= this._maxMessages && turns.length > 1) {
      turns.shift();
    }

    const pruned = flattenTurns(turns);

    while (pruned.length > 0) {
      const first = pruned[0];
      if (first.role !== 'user') { pruned.shift(); continue; }
      if (Array.isArray(first.content) &&
          first.content.some(b => b.type === 'tool_result')) {
        pruned.shift();
        continue;
      }
      break;
    }

    history.length = 0;
    for (const msg of pruned) history.push(msg);

    this._validateAndRepair(chatId);
  }

  repair(chatId) {
    const history = this.get(chatId);
    repair(history);
  }

  validate(chatId) {
    const history = this.get(chatId);
    return validate(history);
  }

  estimateTokens(chatId, systemPromptLength = 0) {
    const history = this.get(chatId);
    let chars = systemPromptLength;
    for (const msg of history) {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.text) chars += b.text.length;
          else if (b.content) chars += (typeof b.content === 'string'
            ? b.content.length : JSON.stringify(b.content).length);
          else if (b.type === 'tool_use') chars += JSON.stringify(b.input || {}).length + (b.name?.length || 0);
        }
      }
    }
    const estimatedTokens = Math.round(chars / 4);
    const pct = Math.min(100, Math.round((estimatedTokens / MAX_CONTEXT) * 100));
    return { messages: history.length, estimatedTokens, maxTokens: MAX_CONTEXT, pct };
  }

  _validateAndRepair(chatId) {
    const history = this.get(chatId);
    const result = validate(history);
    if (!result.valid) {
      console.warn('[history] Auto-repairing:', result.errors.join(', '));
      repair(history);
    }
  }
}

function flattenTurns(turns) {
  const result = [];
  for (const turn of turns) {
    for (const msg of turn) result.push(msg);
  }
  return result;
}

module.exports = { ChatHistory, parseTurns, validate, repair };
