import { defineConfig, devices } from '@playwright/test';

const port = 4387;

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: `npm run build && node test/fixtures/browser-server.ts --port ${port}`,
    port,
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
