const fs = require('fs');
const path = require('path');
const https = require('https');

const definitions = [
  {
    name: 'mermaid_chart',
    description: 'Generate a diagram from a Mermaid definition and send it as an image to the chat. Supports flowcharts, sequence diagrams, ER diagrams, Gantt charts, etc.',
    input_schema: {
      type: 'object',
      properties: {
        definition: { type: 'string', description: 'Mermaid diagram definition (e.g. "graph TD; A-->B")' },
        caption: { type: 'string', description: 'Optional caption for the image' },
        theme: { type: 'string', enum: ['default', 'dark', 'forest', 'neutral'], description: 'Chart theme (default: default)' },
      },
      required: ['definition'],
    },
  },
];

/** @param {string} url @returns {Promise<Buffer>} */
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const handlers = {
  async mermaid_chart(input, memory, context) {
    const telegramCtx = context.ctx;
    if (!telegramCtx) return 'Cannot send charts in this context.';

    const theme = input.theme || 'default';
    const payload = JSON.stringify({ code: input.definition, mermaid: { theme } });
    const encoded = Buffer.from(payload).toString('base64url');
    const url = `https://mermaid.ink/img/${encoded}`;

    let imgBuffer;
    try {
      imgBuffer = await fetchBuffer(url);
    } catch (e) {
      return `Failed to render chart: ${e.message}`;
    }

    const tmpPath = path.join('/tmp', `mermaid-${Date.now()}.png`);
    fs.writeFileSync(tmpPath, imgBuffer);

    try {
      const { InputFile } = require('grammy');
      await telegramCtx.replyWithPhoto(new InputFile(tmpPath), {
        caption: input.caption || undefined,
      });
      return 'Chart sent.';
    } catch (e) {
      return `Failed to send chart: ${e.message}`;
    } finally {
      fs.unlink(tmpPath, () => {});
    }
  },
};

module.exports = { definitions, handlers };
