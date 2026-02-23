const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    root: '.',
  },
});
