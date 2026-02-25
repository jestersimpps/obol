const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { OBOL_DIR } = require('../config');

function runTests(testsDir) {
  if (!fs.existsSync(testsDir)) return { passed: 0, failed: 0, total: 0, output: 'no tests' };

  const testFiles = fs.readdirSync(testsDir).filter(f => f.endsWith('.js') || f.endsWith('.sh'));
  if (testFiles.length === 0) return { passed: 0, failed: 0, total: 0, output: 'no test files' };

  let passed = 0;
  let failed = 0;
  const outputs = [];

  for (const file of testFiles) {
    const testPath = path.join(testsDir, file);
    try {
      const cmd = file.endsWith('.js') ? `node "${testPath}"` : `bash "${testPath}"`;
      const testUtilsPath = path.join(__dirname, '..', 'test-utils.js');
      execSync(cmd, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, OBOL_DIR: OBOL_DIR, NODE_ENV: 'test', OBOL_TEST_UTILS: testUtilsPath },
      });
      passed++;
      outputs.push(`✅ ${file}: passed`);
    } catch (e) {
      failed++;
      const stderr = e.stderr?.substring(0, 200) || e.message.substring(0, 200);
      outputs.push(`❌ ${file}: FAILED\n   ${stderr}`);
    }
  }

  return { passed, failed, total: testFiles.length, output: outputs.join('\n') };
}

module.exports = { runTests };
