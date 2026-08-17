import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './share/wrangler.jsonc' },
      miniflare: {
        bindings: {
          MEHFIL_SHARE_SECRET: 'worker-test-secret',
          SHARE_PREVIEW_IMAGE_URL: '',
        },
      },
    }),
  ],
  test: {
    include: ['test/worker/durable-object.test.ts'],
  },
});
