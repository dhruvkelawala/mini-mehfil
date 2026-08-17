import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  test: {
    include: [
      'test/**/*.test.ts',
      'test/**/*.test.tsx',
      'test/server/**/*.test.js',
    ],
    exclude: ['test/browser/**', 'test/worker/durable-object.test.ts'],
    environment: 'node',
  },
});
