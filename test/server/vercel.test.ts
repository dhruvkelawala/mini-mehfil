import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { test } from 'vitest';

import handler from '../../api/index.ts';
import { createVercelConfig } from '../../src/server/vercel-config.ts';
import { isString } from '../../src/room/primitives.ts';

test('package metadata declares the typed Vercel entrypoint', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const main = isString(packageJson.main) ? packageJson.main : undefined;
  assert.ok(main !== undefined);
  assert.equal(main, 'api/index.ts');
  assert.equal(existsSync(new URL(`../../${main}`, import.meta.url)), true);
});

test('Vercel gives the catch-all function enough time to finish one paid generation', () => {
  const config = createVercelConfig({
    MEHFIL_SHARE_URL: 'https://share.example',
  });
  assert.equal(handler instanceof Function, true);
  assert.equal('builds' in config, false);
  assert.equal('routes' in config, false);
  assert.deepEqual(config.functions, {
    'api/index.ts': { maxDuration: 300, includeFiles: 'dist/host/**' },
  });
  assert.deepEqual(config.rewrites, [
    { source: '/s/:path*', destination: 'https://share.example/s/:path*' },
    { source: '/(.*)', destination: '/api/index.ts' },
  ]);
  assert.deepEqual(config.headers, [
    {
      source: '/s/:id/audio',
      headers: [{ key: 'x-vercel-enable-rewrite-caching', value: '0' }],
    },
  ]);
});

test('Vercel leaves the share route disabled without a valid Worker origin', () => {
  const config = createVercelConfig({});
  assert.deepEqual(config.rewrites, [
    { source: '/(.*)', destination: '/api/index.ts' },
  ]);
  assert.deepEqual(config.headers, []);
  assert.deepEqual(
    createVercelConfig({ MEHFIL_SHARE_URL: 'https://share.example/path' })
      .rewrites,
    [{ source: '/(.*)', destination: '/api/index.ts' }],
  );
});
