const definitions = [
  {
    name: 'store_secret',
    description: 'Store a secret (API key, password, token) in the per-user encrypted secret store. Use when the user provides credentials for services.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Secret name (e.g. gmail-password, notion-token)' },
        value: { type: 'string', description: 'Secret value' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'read_secret',
    description: 'Read a secret by key from the per-user secret store.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Secret name to read' },
      },
      required: ['key'],
    },
  },
  {
    name: 'list_secrets',
    description: 'List all secret keys stored for this user (keys only, not values).',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

const handlers = {
  async store_secret(input, memory, context) {
    const credentials = require('../../auth/credentials');
    credentials.storeSecret(context.userId, input.key, input.value);
    return `Stored secret: ${input.key}`;
  },

  async read_secret(input, memory, context) {
    const credentials = require('../../auth/credentials');
    const val = credentials.readSecret(context.userId, input.key);
    if (val === null) return `Secret not found: ${input.key}`;
    return val;
  },

  async list_secrets(input, memory, context) {
    const credentials = require('../../auth/credentials');
    const keys = credentials.listSecrets(context.userId);
    if (keys.length === 0) return 'No secrets stored.';
    return keys.join('\n');
  },
};

module.exports = { definitions, handlers };
