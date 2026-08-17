import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['test/browser/**', 'test/worker/durable-object.test.ts'],
    environment: 'node',
  },
});
