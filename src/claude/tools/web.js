const { isAllowedUrl } = require('../../sanitize');

const definitions = [{
  name: 'web_fetch',
  description: 'Fetch and extract readable content from a URL.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
    },
    required: ['url'],
  },
}];

const handlers = {
  async web_fetch(input) {
    if (!isAllowedUrl(input.url)) return 'Blocked: URL points to a private/internal address.';
    const jinaUrl = `https://r.jina.ai/${input.url}`;
    const res = await fetch(jinaUrl, {
      headers: { 'Accept': 'text/markdown' },
    });
    if (!res.ok) return `Failed to fetch: HTTP ${res.status}`;
    const text = await res.text();
    return text.substring(0, 15000);
  },
};

module.exports = { definitions, handlers };
