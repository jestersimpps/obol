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

async function cleanWorkspace() {
  const issues = [];
  const errors = [];

  if (!fs.existsSync(OBOL_DIR)) {
    return { issues, errors: ['OBOL_DIR does not exist'] };
  }

  const entries = fs.readdirSync(OBOL_DIR, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(OBOL_DIR, entry.name);

    if (entry.isDirectory()) {
      if (!ALLOWED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        // Rogue directory — check if it has useful files first
        const files = safeReaddir(fullPath);
        if (files.length === 0) {
          // Empty rogue dir — delete
          try {
            fs.rmdirSync(fullPath);
            issues.push({ path: entry.name + '/', action: 'deleted (empty rogue dir)' });
          } catch (e) {
            errors.push(`Failed to remove ${entry.name}/: ${e.message}`);
          }
        } else {
          // Non-empty rogue dir — relocate files, then delete
          for (const file of files) {
            const src = path.join(fullPath, file);
            const dest = guessDestination(file);
            if (dest) {
              try {
                const destPath = path.join(OBOL_DIR, dest, file);
                fs.mkdirSync(path.join(OBOL_DIR, dest), { recursive: true });
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
          // Try to remove the now-empty dir
          try {
            fs.rmdirSync(fullPath);
            issues.push({ path: entry.name + '/', action: 'deleted (rogue dir cleared)' });
          } catch {} // May not be empty if errors occurred
        }
      }
    } else if (entry.isFile()) {
      if (!ALLOWED_FILES.has(entry.name) && !ALLOWED_PATTERNS.some(p => p.test(entry.name))) {
        // Misplaced file at top level
        const dest = guessDestination(entry.name);
        if (dest) {
          try {
            const destPath = path.join(OBOL_DIR, dest, entry.name);
            fs.mkdirSync(path.join(OBOL_DIR, dest), { recursive: true });
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

  // Check for misplaced files within known directories
  const dirFileRules = {
    personality: ['.md'],   // Only markdown
    scripts: ['.js', '.sh'], // Only scripts
    tests: ['.js', '.sh'],   // Only tests
    commands: ['.md'],        // Only markdown
  };

  for (const [dir, allowedExts] of Object.entries(dirFileRules)) {
    const dirPath = path.join(OBOL_DIR, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = safeReaddir(dirPath);
    for (const file of files) {
      const ext = path.extname(file);
      if (ext && !allowedExts.includes(ext)) {
        const dest = guessDestination(file);
        if (dest && dest !== dir) {
          try {
            const src = path.join(dirPath, file);
            const destPath = path.join(OBOL_DIR, dest, file);
            fs.mkdirSync(path.join(OBOL_DIR, dest), { recursive: true });
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
