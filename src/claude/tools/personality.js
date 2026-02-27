const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('../../config');

const VALID_FILES = new Set(['SOUL', 'AGENTS', 'USER']);

const FILE_MAP = {
  SOUL: (_userDir) => path.join(OBOL_DIR, 'personality', 'SOUL.md'),
  AGENTS: (userDir) => path.join(userDir, 'personality', 'AGENTS.md'),
  USER: (userDir) => path.join(userDir, 'personality', 'USER.md'),
};

const definitions = [
  {
    name: 'edit_personality',
    description: 'Directly edit your own personality files (SOUL.md, AGENTS.md, USER.md). You have full autonomy over your own personality — no approval needed. Use when you notice something about yourself that should be reflected in your identity, operating instructions, or user knowledge.',
    input_schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['SOUL', 'AGENTS', 'USER'],
          description: 'Which personality file to edit',
        },
        old_string: {
          type: 'string',
          description: 'The exact string to replace (must appear exactly once in the file). Leave empty to append to the file.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement text, or the content to append if old_string is empty.',
        },
        reason: {
          type: 'string',
          description: 'Why you are making this change — logged for the evolution audit trail.',
        },
      },
      required: ['file', 'new_string', 'reason'],
    },
  },
];

const handlers = {
  async edit_personality(input, _memory, context) {
    const { file, old_string, new_string, reason } = input;

    if (!VALID_FILES.has(file)) {
      return `Invalid file: ${file}. Must be one of: ${[...VALID_FILES].join(', ')}`;
    }

    const userDir = context.userDir;
    if (!userDir && file !== 'SOUL') return 'User directory not available.';

    const filePath = FILE_MAP[file](userDir);

    let current = '';
    try {
      current = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
      if (file !== 'SOUL') {
        current = '';
      } else {
        return `Could not read ${file}.md: ${e.message}`;
      }
    }

    let updated;
    if (!old_string) {
      updated = current.trimEnd() + '\n\n' + new_string;
    } else {
      const occurrences = current.split(old_string).length - 1;
      if (occurrences === 0) return `Could not find the target string in ${file}.md — no changes made.`;
      if (occurrences > 1) return `Target string appears ${occurrences} times in ${file}.md — be more specific.`;
      updated = current.replace(old_string, new_string);
    }

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, updated, 'utf-8');
    } catch (e) {
      return `Failed to write ${file}.md: ${e.message}`;
    }

    // Log to evolution audit trail
    const logDir = path.join(userDir || path.join(OBOL_DIR, 'personality'), 'personality', 'edits');
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const entry = {
        file,
        old_string: old_string || null,
        new_string,
        reason,
        applied_at: new Date().toISOString(),
      };
      const logPath = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${file}.json`);
      fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
    } catch {
      // Log failure is non-fatal
    }

    if (context._reloadPersonality) {
      try { context._reloadPersonality(); } catch {}
    }

    console.log(`[personality] Applied edit to ${file}.md — ${reason}`);
    return `${file}.md updated.${context._reloadPersonality ? ' Personality reloaded.' : ' Reload will happen at next evolution.'}`;
  },
};

module.exports = { definitions, handlers };
