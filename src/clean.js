/**
 * Workspace cleaner — audits ~/.obol/ for misplaced files and rogue directories.
 *
 * Known structure:
 *   config.json, .evolution-state.json, .first-run-done, .post-setup-done
 *   personality/, scripts/, tests/, commands/, apps/, logs/
 *
 * Everything else is flagged. Rogue directories and unknown files are removed.
 * Misplaced files (e.g. a .js in personality/) are moved to the correct location.
 */

const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('./config');

// Allowed top-level entries
const ALLOWED_DIRS = new Set(['personality', 'scripts', 'tests', 'commands', 'apps', 'logs']);
const ALLOWED_FILES = new Set([
  'config.json',
  '.evolution-state.json',
  '.first-run-done',
  '.post-setup-done',
]);
// Files that can appear at top level with any name
const ALLOWED_PATTERNS = [
  /^\./, // Hidden files (dotfiles)
];

// Where file types belong
const FILE_RULES = {
  '.js': 'scripts',
  '.sh': 'scripts',
  '.md': 'commands', // .md files outside personality/ are probably commands
};

async function cleanWorkspace(userDir) {
  const baseDir = userDir || OBOL_DIR;
  const issues = [];
  const errors = [];

  if (!fs.existsSync(baseDir)) {
    return { issues, errors: ['Directory does not exist'] };
  }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry.name);

    if (entry.isDirectory()) {
      if (!ALLOWED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        const files = safeReaddir(fullPath);
        if (files.length === 0) {
          try {
            fs.rmdirSync(fullPath);
            issues.push({ path: entry.name + '/', action: 'deleted (empty rogue dir)' });
          } catch (e) {
            errors.push(`Failed to remove ${entry.name}/: ${e.message}`);
          }
        } else {
          for (const file of files) {
            const src = path.join(fullPath, file);
            const dest = guessDestination(file);
            if (dest) {
              try {
                const destPath = path.join(baseDir, dest, file);
                fs.mkdirSync(path.join(baseDir, dest), { recursive: true });
                fs.renameSync(src, destPath);
                issues.push({ path: `${entry.name}/${file}`, action: `moved → ${dest}/${file}` });
              } catch (e) {
                errors.push(`Failed to move ${entry.name}/${file}: ${e.message}`);
              }
            } else {
              try {
                fs.unlinkSync(src);
                issues.push({ path: `${entry.name}/${file}`, action: 'deleted (unknown type)' });
              } catch (e) {
                errors.push(`Failed to delete ${entry.name}/${file}: ${e.message}`);
              }
            }
          }
          try {
            fs.rmdirSync(fullPath);
            issues.push({ path: entry.name + '/', action: 'deleted (rogue dir cleared)' });
          } catch {}
        }
      }
    } else if (entry.isFile()) {
      if (!ALLOWED_FILES.has(entry.name) && !ALLOWED_PATTERNS.some(p => p.test(entry.name))) {
        const dest = guessDestination(entry.name);
        if (dest) {
          try {
            const destPath = path.join(baseDir, dest, entry.name);
            fs.mkdirSync(path.join(baseDir, dest), { recursive: true });
            fs.renameSync(fullPath, destPath);
            issues.push({ path: entry.name, action: `moved → ${dest}/${entry.name}` });
          } catch (e) {
            errors.push(`Failed to move ${entry.name}: ${e.message}`);
          }
        } else {
          try {
            fs.unlinkSync(fullPath);
            issues.push({ path: entry.name, action: 'deleted (unknown file at root)' });
          } catch (e) {
            errors.push(`Failed to delete ${entry.name}: ${e.message}`);
          }
        }
      }
    }
  }

  const dirFileRules = {
    personality: ['.md'],
    scripts: ['.js', '.sh'],
    tests: ['.js', '.sh'],
    commands: ['.md'],
  };

  for (const [dir, allowedExts] of Object.entries(dirFileRules)) {
    const dirPath = path.join(baseDir, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = safeReaddir(dirPath);
    for (const file of files) {
      const ext = path.extname(file);
      if (ext && !allowedExts.includes(ext)) {
        const dest = guessDestination(file);
        if (dest && dest !== dir) {
          try {
            const src = path.join(dirPath, file);
            const destPath = path.join(baseDir, dest, file);
            fs.mkdirSync(path.join(baseDir, dest), { recursive: true });
            fs.renameSync(src, destPath);
            issues.push({ path: `${dir}/${file}`, action: `moved → ${dest}/${file}` });
          } catch (e) {
            errors.push(`Failed to move ${dir}/${file}: ${e.message}`);
          }
        }
      }
    }
  }

  return { issues, errors };
}

function guessDestination(filename) {
  const ext = path.extname(filename);

  // Test files go to tests/
  if (filename.startsWith('test-') || filename.startsWith('test_')) return 'tests';

  return FILE_RULES[ext] || null;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir).filter(f => {
      try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
    });
  } catch { return []; }
}

module.exports = { cleanWorkspace };
