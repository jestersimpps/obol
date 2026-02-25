const { execFile } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'whisper_transcribe.py');

function transcribe(filePath) {
  return new Promise((resolve) => {
    execFile('python3', [SCRIPT, filePath], { timeout: 60000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

module.exports = { transcribe };
