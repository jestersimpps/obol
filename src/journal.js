const fs = require('fs');
const path = require('path');
const { OBOL_DIR } = require('./config');

const JOURNAL_PATH = path.join(OBOL_DIR, 'journal.md');
const MAX_ENTRY_LENGTH = 500;

function ensureJournal() {
  try {
    if (!fs.existsSync(JOURNAL_PATH)) {
      fs.writeFileSync(JOURNAL_PATH, '# OBOL Journal\n\n', { mode: 0o600 });
    }
  } catch (e) {
    console.error('[journal] Failed to create journal file:', e.message);
  }
}

function addEntry(content) {
  try {
    ensureJournal();
    const timestamp = new Date().toISOString();
    const trimmed = content.length > MAX_ENTRY_LENGTH
      ? content.substring(0, MAX_ENTRY_LENGTH) + '...'
      : content;
    const entry = `**${timestamp}**  \n${trimmed}\n\n`;
    fs.appendFileSync(JOURNAL_PATH, entry);
  } catch (e) {
    console.error('[journal] Failed to add entry:', e.message);
  }
}

function recent(n = 3) {
  try {
    ensureJournal();
    const content = fs.readFileSync(JOURNAL_PATH, 'utf-8');
    const entries = content
      .split(/(?=\*\*\d{4}-\d{2}-\d{2}T)/)
      .filter(e => e.startsWith('**'))
      .slice(-n);
    return entries.length > 0 ? entries.join('').trim() : '';
  } catch (e) {
    console.error('[journal] Failed to read entries:', e.message);
    return '';
  }
}

module.exports = { addEntry, recent };
