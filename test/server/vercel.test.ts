import assert from 'node:assert/strict';

import { test } from 'vitest';

import handler from '../../api/index.ts';
import { createVercelConfig } from '../../src/server/vercel-config.ts';

test('Vercel gives the catch-all function enough time to finish one paid generation', () => {
  const config = createVercelConfig({
    MEHFIL_SHARE_URL: 'https://share.example',
  });
  assert.equal(typeof handler, 'function');
  assert.equal('builds' in config, false);
  assert.equal('routes' in config, false);
  assert.deepEqual(config.functions, {
    'api/index.ts': { maxDuration: 300, includeFiles: 'dist/host/**' },
  });
  assert.deepEqual(config.rewrites, [
    { source: '/s/:path*', destination: 'https://share.example/s/:path*' },
    { source: '/(.*)', destination: '/api/index.ts' },
  ]);
});

test('Vercel leaves the share route disabled without a valid Worker origin', () => {
  assert.deepEqual(createVercelConfig({}).rewrites, [
    { source: '/(.*)', destination: '/api/index.ts' },
  ]);
  assert.deepEqual(
    createVercelConfig({ MEHFIL_SHARE_URL: 'https://share.example/path' })
      .rewrites,
    [{ source: '/(.*)', destination: '/api/index.ts' }],
  );
});
