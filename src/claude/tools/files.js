const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveUserPath } = require('../utils');

const definitions = [
  {
    name: 'read_file',
    description: 'Read contents of a file. Supports text files and PDFs. Use offset and limit for large files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file. old_string must appear exactly once. Prefer this over write_file for surgical edits.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        old_string: { type: 'string', description: 'Text to replace — must be unique in the file' },
        new_string: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern within your workspace. E.g. **/*.js, scripts/*.sh, test-*.js',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents for a pattern within your workspace. Returns matching lines with file and line number.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex)' },
        path: { type: 'string', description: 'File or directory to search (default: workspace root)' },
        glob: { type: 'string', description: 'Limit search to files matching this glob pattern, e.g. *.js' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'send_file',
    description: 'Send a file to the user via Telegram (PDF, image, document, etc). Use after generating files the user requested.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to send' },
        caption: { type: 'string', description: 'Optional caption for the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'create_pdf',
    description: 'Create a professional PDF document from Typst markup. Use for reports, letters, invoices, resumes, documentation. The content parameter takes Typst markup. After creating, use send_file to deliver it.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Typst markup content for the document' },
        filename: { type: 'string', description: 'Output filename without extension (default: document)' },
      },
      required: ['content'],
    },
  },
];

const handlers = {
  async read_file(input, memory, context) {
    const { userDir } = context;
    const filePath = userDir ? resolveUserPath(input.path, userDir) : input.path;
    if (filePath.toLowerCase().endsWith('.pdf')) {
      const pdfParse = require('pdf-parse');
      const { text } = await pdfParse(fs.readFileSync(filePath));
      const truncated = text.substring(0, 50000);
      return text.length > 50000 ? truncated + '\n...(truncated)' : truncated;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (input.offset || input.limit) {
      const lines = raw.split('\n');
      const start = Math.max(0, (input.offset || 1) - 1);
      const slice = input.limit ? lines.slice(start, start + input.limit) : lines.slice(start);
      const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n');
      const totalLines = lines.length;
      const end = start + slice.length;
      return `Lines ${start + 1}-${end} of ${totalLines}:\n${numbered}`;
    }
    const truncated = raw.substring(0, 50000);
    return raw.length > 50000 ? truncated + '\n...(truncated)' : truncated;
  },

  async write_file(input, memory, context) {
    const { userDir } = context;
    const filePath = userDir ? resolveUserPath(input.path, userDir) : input.path;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, input.content);
    if (filePath.includes('personality/')) {
      context._reloadPersonality?.();
    }
    return `Written: ${filePath}`;
  },

  async edit_file(input, memory, context) {
    const { userDir } = context;
    const filePath = userDir ? resolveUserPath(input.path, userDir) : input.path;
    const content = fs.readFileSync(filePath, 'utf-8');
    const count = content.split(input.old_string).length - 1;
    if (count === 0) return `Error: old_string not found in ${input.path}`;
    if (count > 1) return `Error: old_string matches ${count} times — add more context to make it unique`;
    fs.writeFileSync(filePath, content.replace(input.old_string, input.new_string));
    if (filePath.includes('personality/')) {
      context._reloadPersonality?.();
    }
    return `Edited: ${filePath}`;
  },

  async glob(input, memory, context) {
    const { userDir } = context;
    const cwd = userDir || '/tmp';
    const files = [];
    for await (const f of fsPromises.glob(input.pattern, { cwd })) {
      files.push(f);
    }
    if (files.length === 0) return 'No files found matching pattern.';
    return files.sort().join('\n');
  },

  async grep(input, memory, context) {
    const { userDir } = context;
    const searchRoot = input.path
      ? resolveUserPath(input.path, userDir)
      : (userDir || '/tmp');
    const args = ['-r', '-n', '--include', input.glob || '*', input.pattern, searchRoot];
    try {
      const output = execFileSync('grep', args, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
      const lines = output.trim().split('\n');
      // Make paths relative to userDir for cleaner output
      const relative = lines.map(l => l.replace(searchRoot + '/', ''));
      const truncated = relative.slice(0, 200);
      return truncated.join('\n') + (lines.length > 200 ? `\n...(${lines.length - 200} more lines)` : '');
    } catch (e) {
      if (e.status === 1) return 'No matches found.';
      throw e;
    }
  },

  async send_file(input, memory, context) {
    const { userDir } = context;
    const filePath = userDir ? resolveUserPath(input.path, userDir) : input.path;
    if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;
    const telegramCtx = context.ctx;
    if (!telegramCtx) return 'Cannot send files in this context.';
    const { InputFile } = require('grammy');
    await telegramCtx.replyWithDocument(new InputFile(filePath), {
      caption: input.caption || undefined,
    });
    return `Sent: ${path.basename(filePath)}`;
  },

  async create_pdf(input, memory, context) {
    const { userDir } = context;
    const filename = (input.filename || 'document').replace(/[^a-zA-Z0-9_-]/g, '');
    const tmpDir = path.join(userDir || '/tmp', '.typst');
    fs.mkdirSync(tmpDir, { recursive: true });
    const typFile = path.join(tmpDir, `${filename}.typ`);
    const pdfFile = path.join(userDir || '/tmp', `${filename}.pdf`);
    fs.writeFileSync(typFile, input.content);
    try {
      execFileSync('typst', ['compile', typFile, pdfFile], {
        encoding: 'utf-8',
        timeout: 30000,
      });
    } catch (e) {
      return `Typst compilation failed: ${e.stderr || e.message}`;
    }
    if (!fs.existsSync(pdfFile)) return 'PDF creation failed — no output file.';
    return `PDF created: ${pdfFile}`;
  },
};

module.exports = { definitions, handlers };
