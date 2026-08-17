import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { parseTcpPort } from './src/config/runtime.ts';

export default defineConfig(({ mode }) => {
  if (mode !== 'listener' && mode !== 'host') {
    throw new Error(`Unsupported Vite mode: ${mode}`);
  }
  const surface = mode === 'listener' ? 'listener' : 'host';
  return {
    plugins: [solid()],
    define: {
      __MEHFIL_REPLAY__: JSON.stringify(
        Boolean(process.env.MEHFIL_REPLAY_AUDIO),
      ),
    },
    root: resolve(`src/client/${surface}`),
    publicDir: false,
    build: {
      outDir: resolve(`dist/${surface}`),
      emptyOutDir: true,
      manifest: true,
    },
    ...(mode === 'host'
      ? {
          server: {
            strictPort: true,
            proxy: {
              '/api': `http://127.0.0.1:${parseTcpPort(process.env.MEHFIL_DEV_API_PORT ?? '4174', 'MEHFIL_DEV_API_PORT')}`,
            },
          },
        }
      : {}),
  };
});
