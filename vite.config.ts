import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

function developmentApiPort(value: string | undefined): number {
  const candidate = value ?? '4174';
  if (!/^\d+$/.test(candidate)) {
    throw new Error(
      'MEHFIL_DEV_API_PORT must be an integer TCP port from 1 to 65535.',
    );
  }
  const port = Number(candidate);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      'MEHFIL_DEV_API_PORT must be an integer TCP port from 1 to 65535.',
    );
  }
  return port;
}

export default defineConfig(({ mode }) => {
  if (mode !== 'listener' && mode !== 'host') {
    throw new Error(`Unsupported Vite mode: ${mode}`);
  }
  const surface = mode === 'listener' ? 'listener' : 'host';
  return {
    plugins: [solid()],
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
              '/api': `http://127.0.0.1:${developmentApiPort(process.env.MEHFIL_DEV_API_PORT)}`,
            },
          },
        }
      : {}),
  };
});
