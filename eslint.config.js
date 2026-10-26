const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'public/vendor/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    files: ['server.js', 'db.js', 'lib/**/*.js', 'scripts/**/*.js', 'eslint.config.js', 'test/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    // Playwright specs run in Node; code passed to page.evaluate runs in the browser
    files: ['e2e/**/*.js', 'playwright.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
  },
];
