const fs = require('fs');
const path = require('path');

function readDir(dir) {
  const files = {};
  if (!fs.existsSync(dir)) return files;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isFile()) {
      files[f] = fs.readFileSync(full, 'utf-8');
    }
  }
  return files;
}

function syncDir(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (content && content.trim()) {
      fs.writeFileSync(path.join(dir, name), content);
    }
  }
  for (const f of fs.readdirSync(dir)) {
    if (!(f in files)) {
      const full = path.join(dir, f);
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
}

module.exports = { readDir, syncDir };
