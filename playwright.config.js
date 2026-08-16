const { defineConfig, devices } = require('@playwright/test');
const os = require('node:os');
const path = require('node:path');

const port = 4174;

module.exports = defineConfig({
  testDir: './test/browser',
  outputDir: path.join(os.tmpdir(), 'mini-mehfil-playwright-results'),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'node server.js',
    env: { ...process.env, PORT: String(port) },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000
  }
});
