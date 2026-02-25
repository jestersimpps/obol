const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveUserPath } = require('../utils');

const definitions = [
  {
    name: 'read_file',
    description: 'Read contents of a file. Supports text files and PDFs (extracts text from PDF automatically).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
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
      const pdfBuffer = fs.readFileSync(filePath);
      const { text } = await pdfParse(pdfBuffer);
      const truncatedPdf = text.substring(0, 50000);
      return text.length > 50000 ? truncatedPdf + '\n...(truncated)' : truncatedPdf;
    }
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const truncatedFile = fileContent.substring(0, 50000);
    return fileContent.length > 50000 ? truncatedFile + '\n...(truncated)' : truncatedFile;
  },

  async write_file(input, memory, context) {
    const { userDir } = context;
    const filePath = userDir ? resolveUserPath(input.path, userDir) : input.path;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, input.content);
    if (path.basename(filePath) === 'traits.json' || filePath.includes('personality/')) {
      context._reloadPersonality?.();
    }
    return `Written: ${filePath}`;
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
