const { MAX_EXEC_TIMEOUT, BLOCKED_EXEC_PATTERNS, SENSITIVE_READ_PATHS } = require('../constants');
const { execAsync } = require('../../sanitize');

const definitions = [{
  name: 'exec',
  description: 'Execute a shell command and return the output. Use for file operations, system tasks, running scripts.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in seconds (default 30)' },
    },
    required: ['command'],
  },
}];

const handlers = {
  async exec(input, memory, context) {
    const { userDir } = context;
    for (const pattern of BLOCKED_EXEC_PATTERNS) {
      if (pattern.test(input.command)) {
        return `Blocked: "${input.command}" matches a dangerous pattern. Ask the user for confirmation first.`;
      }
    }
    if (userDir) {
      for (const pattern of SENSITIVE_READ_PATHS) {
        if (pattern.test(input.command)) {
          return `Blocked: command accesses a sensitive path. Ask the user for confirmation first.`;
        }
      }
    }
    const timeout = Math.min(input.timeout || 30, MAX_EXEC_TIMEOUT) * 1000;
    const realHome = process.env.HOME || '/root';
    const output = await execAsync(input.command, {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 1024 * 1024,
      cwd: userDir || undefined,
      env: userDir ? {
        ...process.env,
        HOME: userDir,
        GNUPGHOME: process.env.GNUPGHOME || `${realHome}/.gnupg`,
        PASSWORD_STORE_DIR: process.env.PASSWORD_STORE_DIR || `${realHome}/.password-store`,
      } : process.env,
    });
    const truncated = output.substring(0, 10000);
    return output.length > 10000 ? truncated + '\n...(truncated)' : truncated;
  },
};

module.exports = { definitions, handlers };
