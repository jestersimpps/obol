const { MAX_EXEC_TIMEOUT, BLOCKED_EXEC_PATTERNS } = require('../constants');
const { execAsync } = require('../../sanitize');

const ALLOWED_PATH_PREFIXES = [
  '/usr/', '/bin/', '/sbin/', '/lib/', '/lib64/', '/lib32/',
  '/opt/',
  '/tmp/',
  '/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin',
  '/proc/self/',
];

/** Extract absolute path tokens from a shell command */
function extractAbsolutePaths(command) {
  const re = /(?:^|[\s=|&;<>('"])(\/[\w.\-/]*)/g;
  const paths = new Set();
  let m;
  while ((m = re.exec(command)) !== null) {
    paths.add(m[1]);
  }
  return [...paths];
}

/** Returns true if path is within userDir or a safe system prefix */
function isAllowedPath(p, userDir) {
  if (p === userDir || p.startsWith(userDir + '/')) return true;
  return ALLOWED_PATH_PREFIXES.some(prefix => p.startsWith(prefix));
}

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
      const blockedPaths = extractAbsolutePaths(input.command).filter(p => !isAllowedPath(p, userDir));
      if (blockedPaths.length > 0) {
        return `Blocked: command accesses path(s) outside your workspace: ${blockedPaths.join(', ')}`;
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
