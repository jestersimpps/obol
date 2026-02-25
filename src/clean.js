const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('./config');

const ALLOWED_DIRS = new Set(['personality', 'scripts', 'tests', 'commands', 'apps', 'logs', 'assets']);
const ALLOWED_FILES = new Set([
  'config.json',
  '.evolution-state.json',
  '.first-run-done',
  '.post-setup-done',
]);
const ALLOWED_PATTERNS = [/^\./];

const FILE_RULES = {
  '.js': 'scripts',
  '.sh': 'scripts',
  '.md': 'commands',
};

const DIR_FILE_RULES = {
  personality: ['.md'],
  scripts: ['.js', '.sh'],
  tests: ['.js', '.sh'],
  commands: ['.md'],
};

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir).filter(f => {
      try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
    });
  } catch { return []; }
}

function safeReaddirAll(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function guessDestination(filename) {
  const ext = path.extname(filename);
  if (filename.startsWith('test-') || filename.startsWith('test_')) return 'tests';
  return FILE_RULES[ext] || null;
}

/**
 * @param {string} userDir
 * @returns {Array<{type: string, name: string, children?: string[], currentDir?: string}>}
 */
function scanWorkspace(userDir) {
  const rogueItems = [];
  if (!fs.existsSync(userDir)) return rogueItems;

  const entries = fs.readdirSync(userDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ALLOWED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        rogueItems.push({ type: 'dir', name: entry.name, children: safeReaddirAll(path.join(userDir, entry.name)) });
      }
    } else if (entry.isFile()) {
      if (!ALLOWED_FILES.has(entry.name) && !ALLOWED_PATTERNS.some(p => p.test(entry.name))) {
        rogueItems.push({ type: 'file', name: entry.name });
      }
    }
  }

  for (const [dir, allowedExts] of Object.entries(DIR_FILE_RULES)) {
    const dirPath = path.join(userDir, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of safeReaddir(dirPath)) {
      const ext = path.extname(file);
      if (ext && !allowedExts.includes(ext)) {
        rogueItems.push({ type: 'misplaced', name: file, currentDir: dir });
      }
    }
  }

  return rogueItems;
}

/**
 * @param {Array} rogueItems
 * @param {object} claudeClient - Anthropic client instance
 * @returns {Promise<Array<{path: string, action: string, dest?: string}>|null>}
 */
async function resolveWithLlm(rogueItems, claudeClient) {
  const itemList = rogueItems.map(item => {
    if (item.type === 'dir') {
      return `- Directory "${item.name}/" containing: ${item.children.length ? item.children.join(', ') : '(empty)'}`;
    }
    if (item.type === 'misplaced') {
      return `- File "${item.currentDir}/${item.name}" (wrong location for its type)`;
    }
    return `- File "${item.name}" at root level`;
  }).join('\n');

  const prompt = `You are organizing a workspace directory. The valid structure is:
- personality/ — .md files (soul, personality config)
- scripts/ — .js and .sh scripts
- tests/ — test files (test-*.js, test_*.js, *.test.js)
- commands/ — .md command definitions
- apps/ — application subdirectories
- logs/ — log files
- assets/ — media and binary assets

These items don't belong in their current location:
${itemList}

For each item, decide: "move" to a valid directory, or "delete" if truly rogue/irrelevant.
Respond ONLY with a JSON array, no explanation:
[{"path":"item-name","action":"move|delete","dest":"destination-dir"}]
For directories use "dirname/", for misplaced files use "currentDir/filename".`;

  const response = await claudeClient.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.text || '[]';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * @param {string} userDir
 * @param {Array} rogueItems
 * @param {Array} decisions
 * @returns {{issues: Array, errors: Array}}
 */
function applyDecisions(userDir, rogueItems, decisions) {
  const issues = [];
  const errors = [];

  for (const decision of decisions) {
    const item = rogueItems.find(r => {
      if (r.type === 'dir') return decision.path === r.name + '/';
      if (r.type === 'misplaced') return decision.path === `${r.currentDir}/${r.name}`;
      return decision.path === r.name;
    });
    if (!item) continue;

    const srcPath = item.type === 'misplaced'
      ? path.join(userDir, item.currentDir, item.name)
      : path.join(userDir, item.name);

    if (decision.action === 'delete') {
      try {
        fs.rmSync(srcPath, { recursive: true, force: true });
        issues.push({ path: decision.path, action: 'deleted' });
      } catch (e) {
        errors.push(`Failed to delete ${decision.path}: ${e.message}`);
      }
    } else if (decision.action === 'move' && decision.dest) {
      const destDir = path.join(userDir, decision.dest);
      const destPath = path.join(destDir, item.name);
      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(srcPath, destPath);
        issues.push({ path: decision.path, action: `moved → ${decision.dest}/${item.name}` });
      } catch (e) {
        errors.push(`Failed to move ${decision.path}: ${e.message}`);
      }
    }
  }

  return { issues, errors };
}

/**
 * @param {string} userDir
 * @param {Array} rogueItems
 * @returns {{issues: Array, errors: Array}}
 */
function applyHeuristics(userDir, rogueItems) {
  const issues = [];
  const errors = [];

  for (const item of rogueItems) {
    if (item.type === 'dir') {
      const fullPath = path.join(userDir, item.name);
      const files = safeReaddir(fullPath);

      if (item.children.length === 0) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          issues.push({ path: item.name + '/', action: 'deleted (empty rogue dir)' });
        } catch (e) {
          errors.push(`Failed to remove ${item.name}/: ${e.message}`);
        }
      } else {
        for (const file of files) {
          const dest = guessDestination(file);
          if (dest) {
            try {
              const destPath = path.join(userDir, dest, file);
              fs.mkdirSync(path.join(userDir, dest), { recursive: true });
              fs.renameSync(path.join(fullPath, file), destPath);
              issues.push({ path: `${item.name}/${file}`, action: `moved → ${dest}/${file}` });
            } catch (e) {
              errors.push(`Failed to move ${item.name}/${file}: ${e.message}`);
            }
          } else {
            try {
              fs.unlinkSync(path.join(fullPath, file));
              issues.push({ path: `${item.name}/${file}`, action: 'deleted (unknown type)' });
            } catch (e) {
              errors.push(`Failed to delete ${item.name}/${file}: ${e.message}`);
            }
          }
        }
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          issues.push({ path: item.name + '/', action: 'deleted (rogue dir cleared)' });
        } catch {}
      }
    } else if (item.type === 'file') {
      const dest = guessDestination(item.name);
      const fullPath = path.join(userDir, item.name);
      if (dest) {
        try {
          const destPath = path.join(userDir, dest, item.name);
          fs.mkdirSync(path.join(userDir, dest), { recursive: true });
          fs.renameSync(fullPath, destPath);
          issues.push({ path: item.name, action: `moved → ${dest}/${item.name}` });
        } catch (e) {
          errors.push(`Failed to move ${item.name}: ${e.message}`);
        }
      } else {
        try {
          fs.unlinkSync(fullPath);
          issues.push({ path: item.name, action: 'deleted (unknown file at root)' });
        } catch (e) {
          errors.push(`Failed to delete ${item.name}: ${e.message}`);
        }
      }
    } else if (item.type === 'misplaced') {
      const dest = guessDestination(item.name);
      if (dest && dest !== item.currentDir) {
        const src = path.join(userDir, item.currentDir, item.name);
        try {
          const destPath = path.join(userDir, dest, item.name);
          fs.mkdirSync(path.join(userDir, dest), { recursive: true });
          fs.renameSync(src, destPath);
          issues.push({ path: `${item.currentDir}/${item.name}`, action: `moved → ${dest}/${item.name}` });
        } catch (e) {
          errors.push(`Failed to move ${item.currentDir}/${item.name}: ${e.message}`);
        }
      }
    }
  }

  return { issues, errors };
}

/**
 * @param {string} userDir
 * @param {object|null} claudeClient - optional Anthropic client for LLM-based resolution
 * @returns {Promise<{issues: Array, errors: Array}>}
 */
async function cleanWorkspace(userDir, claudeClient = null) {
  const baseDir = userDir || OBOL_DIR;
  if (!fs.existsSync(baseDir)) {
    return { issues: [], errors: ['Directory does not exist'] };
  }

  const rogueItems = scanWorkspace(baseDir);
  if (rogueItems.length === 0) return { issues: [], errors: [] };

  if (claudeClient) {
    try {
      const decisions = await resolveWithLlm(rogueItems, claudeClient);
      if (decisions) return applyDecisions(baseDir, rogueItems, decisions);
    } catch (e) {
      console.error('[clean] LLM resolution failed, falling back to heuristics:', e.message);
    }
  }

  return applyHeuristics(baseDir, rogueItems);
}

module.exports = { cleanWorkspace };
