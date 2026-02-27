const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('./config');

const ALLOWED_DIRS = new Set(['personality', 'scripts', 'tests', 'commands', 'apps', 'logs', 'assets']);
const ALLOWED_ROOT_FILES = new Set([
  'config.json',
  'secrets.json',
  '.evolution-state.json',
  '.first-run-done',
  '.post-setup-done',
]);
const TEMP_DOTDIRS = new Set(['.typst', '.tmp']);

// Extensions that belong in scripts/
const SCRIPT_EXTS = new Set(['.js', '.ts', '.sh', '.py', '.rb', '.php', '.go', '.rs', '.pl', '.lua']);
// Extensions that belong in assets/
const ASSET_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.mp4', '.mp3', '.wav', '.pdf', '.zip']);

// Dirs where only .md files are allowed (with per-dir exceptions)
const MD_ONLY_DIRS = new Set(['personality', 'commands']);
const MD_DIR_EXCEPTIONS = {};

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

/** @param {string} filename @returns {string|null} */
function guessDestination(filename) {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext).toLowerCase();
  if (base.startsWith('test-') || base.startsWith('test_') || base.endsWith('.test') || base.endsWith('.spec')) return 'tests';
  if (SCRIPT_EXTS.has(ext)) return 'scripts';
  if (ASSET_EXTS.has(ext)) return 'assets';
  if (ext === '.md') return 'commands';
  if (ext === '.log') return 'logs';
  return null;
}

/**
 * @param {string} userDir
 * @returns {Array<{type: string, name: string, dest?: string, children?: string[], currentDir?: string}>}
 */
function scanWorkspace(userDir) {
  const issues = [];
  if (!fs.existsSync(userDir)) return issues;

  const entries = fs.readdirSync(userDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (TEMP_DOTDIRS.has(entry.name)) {
        issues.push({ type: 'dir', name: entry.name, dest: null, children: [] });
      } else if (!ALLOWED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        issues.push({ type: 'dir', name: entry.name, dest: 'apps', children: safeReaddirAll(path.join(userDir, entry.name)) });
      }
    } else if (entry.isFile()) {
      if (!ALLOWED_ROOT_FILES.has(entry.name) && !entry.name.startsWith('.')) {
        const dest = guessDestination(entry.name);
        issues.push({ type: 'file', name: entry.name, dest });
      }
    }
  }

  // Check md-only dirs for non-.md files
  for (const dir of MD_ONLY_DIRS) {
    const dirPath = path.join(userDir, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of safeReaddir(dirPath)) {
      if (file.startsWith('.')) continue;
      if (path.extname(file).toLowerCase() !== '.md' && !MD_DIR_EXCEPTIONS[dir]?.has(file)) {
        const dest = guessDestination(file);
        issues.push({ type: 'misplaced', name: file, currentDir: dir, dest });
      }
    }
  }

  return issues;
}

/**
 * @param {string} baseDir
 * @param {Array} issues
 * @returns {{issues: Array, errors: Array}}
 */
function applyIssues(baseDir, issues) {
  const applied = [];
  const errors = [];

  for (const item of issues) {
    if (item.type === 'dir') {
      const src = path.join(baseDir, item.name);
      if (!item.dest || item.children.length === 0) {
        try {
          // Use rename to an apps/ subdir first, then attempt rmSync
          // rmSync may be blocked in sandboxed environments — fall back to moving
          const emptyDest = path.join(baseDir, 'apps', item.name.replace(/^\./, '_dot_'));
          try {
            fs.rmSync(src, { recursive: true, force: true });
            applied.push({ path: item.name + '/', action: 'deleted (empty dir)' });
          } catch {
            fs.mkdirSync(path.join(baseDir, 'apps'), { recursive: true });
            fs.renameSync(src, emptyDest);
            applied.push({ path: item.name + '/', action: `moved → apps/${path.basename(emptyDest)}/ (delete blocked)` });
          }
        } catch (e) {
          errors.push(`Failed to clean ${item.name}/: ${e.message}`);
        }
      } else {
        const dest = path.join(baseDir, 'apps', item.name);
        try {
          fs.mkdirSync(path.join(baseDir, 'apps'), { recursive: true });
          fs.renameSync(src, dest);
          applied.push({ path: item.name + '/', action: `moved → apps/${item.name}/` });
        } catch (e) {
          errors.push(`Failed to move ${item.name}/: ${e.message}`);
        }
      }
    } else if (item.type === 'file') {
      const src = path.join(baseDir, item.name);
      if (item.dest) {
        const destDir = path.join(baseDir, item.dest);
        try {
          fs.mkdirSync(destDir, { recursive: true });
          fs.renameSync(src, path.join(destDir, item.name));
          applied.push({ path: item.name, action: `moved → ${item.dest}/${item.name}` });
        } catch (e) {
          errors.push(`Failed to move ${item.name}: ${e.message}`);
        }
      } else {
        errors.push(`Don't know where to put ${item.name} — move it manually`);
      }
    } else if (item.type === 'misplaced') {
      const src = path.join(baseDir, item.currentDir, item.name);
      if (item.dest && item.dest !== item.currentDir) {
        const destDir = path.join(baseDir, item.dest);
        try {
          fs.mkdirSync(destDir, { recursive: true });
          fs.renameSync(src, path.join(destDir, item.name));
          applied.push({ path: `${item.currentDir}/${item.name}`, action: `moved → ${item.dest}/${item.name}` });
        } catch (e) {
          errors.push(`Failed to move ${item.currentDir}/${item.name}: ${e.message}`);
        }
      } else {
        errors.push(`Don't know where to put ${item.currentDir}/${item.name} — move it manually`);
      }
    }
  }

  return { issues: applied, errors };
}

/**
 * @param {string} userDir
 * @returns {Promise<{baseDir: string, issues: Array}>}
 */
async function planClean(userDir) {
  const baseDir = userDir || OBOL_DIR;
  if (!fs.existsSync(baseDir)) return { baseDir, issues: [] };
  return { baseDir, issues: scanWorkspace(baseDir) };
}

/**
 * @param {string} baseDir
 * @param {Array} issues
 * @returns {{issues: Array, errors: Array}}
 */
function applyPlan(baseDir, issues) {
  return applyIssues(baseDir, issues);
}

/**
 * Convenience wrapper: plan + apply in one call.
 * @param {string} userDir
 * @returns {Promise<{issues: Array, errors: Array}>}
 */
async function cleanWorkspace(userDir) {
  const plan = await planClean(userDir);
  if (plan.issues.length === 0) return { issues: [], errors: [] };
  return applyPlan(plan.baseDir, plan.issues);
}

module.exports = { planClean, applyPlan, cleanWorkspace };
