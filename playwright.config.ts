import { defineConfig, devices } from '@playwright/test';

const port = 4387;
const replayVideo = Boolean(process.env.MEHFIL_REPLAY_VIDEO_DIR);

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: replayVideo ? 'on' : 'off',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: `pnpm run build && node test/fixtures/browser-server.ts --port ${port}`,
    port,
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
