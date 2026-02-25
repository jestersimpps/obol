const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION_RE = /^v?(\d+\.\d+\.\d+)$/;

/** @returns {{ version: string, hash: string }[]} */
function getVersionCommits() {
  const log = execSync('git log --oneline --all', { encoding: 'utf-8' });
  const versions = [];
  for (const line of log.split('\n')) {
    const [hash, ...rest] = line.trim().split(' ');
    if (!hash) continue;
    const msg = rest.join(' ');
    const match = msg.match(VERSION_RE);
    if (match) versions.push({ version: match[1], hash });
  }
  return versions;
}

/** @returns {{ version: string, commits: string[] }[]} */
function buildChangelog() {
  const versions = getVersionCommits();
  const sections = [];

  for (let i = 0; i < versions.length; i++) {
    const current = versions[i];
    const prev = versions[i + 1];
    const range = prev ? `${prev.hash}..${current.hash}` : current.hash;

    const log = execSync(`git log --oneline ${range}`, { encoding: 'utf-8' });
    const commits = log
      .split('\n')
      .map(l => l.replace(/^[a-f0-9]+\s+/, '').trim())
      .filter(msg => msg && !VERSION_RE.test(msg));

    if (commits.length > 0) {
      sections.push({ version: current.version, commits });
    }
  }

  return sections;
}

function generate() {
  const sections = buildChangelog();
  const md = sections
    .map(s => `## ${s.version}\n${s.commits.map(c => `- ${c}`).join('\n')}`)
    .join('\n\n');

  const out = path.join(__dirname, '..', '..', 'CHANGELOG.md');
  fs.writeFileSync(out, md + '\n');
  console.log(`CHANGELOG.md written (${sections.length} versions)`);
}

/** @param {string} changelog @returns {string|null} */
function extractLatestSection(changelog) {
  const match = changelog.match(/^## .+\n([\s\S]*?)(?=\n## |\s*$)/);
  if (!match) return null;
  return match[1].trim();
}

/** @returns {string|null} */
function readInstalledChangelog() {
  try {
    const pkgPath = require.resolve('obol-ai/package.json');
    const changelogPath = path.join(path.dirname(pkgPath), 'CHANGELOG.md');
    return fs.readFileSync(changelogPath, 'utf-8');
  } catch {
    return null;
  }
}

/** @returns {string|null} */
function getLatestChanges() {
  const changelog = readInstalledChangelog();
  if (!changelog) return null;
  return extractLatestSection(changelog);
}

if (require.main === module) generate();

module.exports = { generate, getLatestChanges, extractLatestSection };
