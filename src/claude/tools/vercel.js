const { execFileSync } = require('child_process');
const { resolveUserPath } = require('../utils');

const definitions = [
  {
    name: 'vercel_deploy',
    description: 'Deploy a directory to Vercel. Use to ship websites, dashboards, and web apps for the user.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Path to the project directory to deploy' },
        name: { type: 'string', description: 'Project name' },
        production: { type: 'boolean', description: 'Deploy to production (default false = preview)' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'vercel_list',
    description: 'List Vercel deployments for a project.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name' },
      },
      required: ['project'],
    },
  },
];

const handlers = {
  async vercel_deploy(input, memory, context) {
    const token = context.config?.vercel?.token;
    if (!token) return 'Vercel not configured.';
    const dir = context.userDir ? resolveUserPath(input.directory, context.userDir) : input.directory;
    const args = ['vercel', '--yes'];
    if (input.production) args.push('--prod');
    if (input.name) {
      const safeName = input.name.replace(/[^a-zA-Z0-9_-]/g, '');
      if (safeName) args.push('--name', safeName);
    }
    const output = execFileSync('npx', args, {
      encoding: 'utf-8',
      timeout: 120000,
      cwd: dir,
      env: { ...process.env, VERCEL_TOKEN: token },
    });
    const truncated = output.substring(0, 5000);
    return output.length > 5000 ? truncated + '\n...(truncated)' : truncated;
  },

  async vercel_list(input, memory, context) {
    const token = context.config?.vercel?.token;
    if (!token) return 'Vercel not configured.';
    const listArgs = ['vercel', 'ls'];
    if (input.project) {
      const safeProject = input.project.replace(/[^a-zA-Z0-9_\-./]/g, '');
      if (safeProject) listArgs.push(safeProject);
    }
    const output = execFileSync('npx', listArgs, {
      encoding: 'utf-8', timeout: 30000, env: { ...process.env, VERCEL_TOKEN: token },
    });
    return output.substring(0, 5000);
  },
};

module.exports = { definitions, handlers };
