import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig(({ mode }) => {
  if (mode !== 'listener' && mode !== 'host') {
    throw new Error(`Unsupported Vite mode: ${mode}`);
  }
  const surface = mode === 'listener' ? 'listener' : 'host';
  return {
    plugins: [solid()],
    root: resolve(`src/client/${surface}`),
    build: {
      outDir: resolve(`dist/${surface}`),
      emptyOutDir: true,
      manifest: true,
    },
    ...(mode === 'host'
      ? { server: { proxy: { '/api': 'http://127.0.0.1:4174' } } }
      : {}),
  };
});
