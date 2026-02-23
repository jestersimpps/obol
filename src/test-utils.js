#!/usr/bin/env node
/**
 * Shared test utilities for OBOL.
 * Used by both core tests and Opus-generated script tests.
 *
 * Usage:
 *   const { test, run, runFail, report } = require('obol/src/test-utils');
 *
 *   test('should do X', () => {
 *     const out = run('my-script.js', '--flag value');
 *     if (!out.includes('expected')) throw new Error('missing expected output');
 *   });
 *
 *   report();
 */

const { execSync } = require('child_process');
const path = require('path');

let passed = 0;
let failed = 0;
let suiteName = '';

/**
 * Set the suite name (printed as header)
 */
function suite(name) {
  suiteName = name;
  console.log(`\n${name}`);
}

/**
 * Run a single test case
 */
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${name}: ${e.message}`);
  }
}

/**
 * Execute a script and return stdout. Throws on non-zero exit.
 * @param {string} scriptPath - Absolute path or relative to cwd
 * @param {string} args - CLI arguments
 * @param {object} opts - { env, timeout, cwd }
 */
function run(scriptPath, args = '', opts = {}) {
  const ext = path.extname(scriptPath);
  const cmd = ext === '.sh' ? 'bash' : 'node';
  const timeout = opts.timeout || 30000;
  return execSync(`${cmd} "${scriptPath}" ${args}`, {
    encoding: 'utf-8',
    timeout,
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Execute a script expecting failure (non-zero exit).
 * Returns true if it failed, false if it succeeded (which is unexpected).
 */
function runFail(scriptPath, args = '', opts = {}) {
  try {
    run(scriptPath, args, opts);
    return false; // Should have failed
  } catch {
    return true; // Expected failure
  }
}

/**
 * Assert helper — throws if condition is false
 */
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

/**
 * Assert two values are equal
 */
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected "${expected}", got "${actual}"`);
  }
}

/**
 * Assert string includes substring
 */
function assertIncludes(str, substr, message) {
  if (!str.includes(substr)) {
    throw new Error(message || `expected "${str}" to include "${substr}"`);
  }
}

/**
 * Print results and exit with appropriate code
 */
function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

module.exports = { suite, test, run, runFail, assert, assertEqual, assertIncludes, report };
