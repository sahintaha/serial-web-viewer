// End-to-end tests (npm run test:e2e). The servers are started by the specs themselves
// (e2e/harness.js), so no webServer block is needed. Locally an installed browser can be
// used instead of downloading one: PW_CHANNEL=msedge npm run test:e2e
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // the server specs share one mock serial port
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    channel: process.env.PW_CHANNEL || undefined,
    locale: 'tr-TR',
    trace: 'retain-on-failure',
  },
});
