const test = require('node:test');
const assert = require('node:assert/strict');
const { createVercelConfig } = require('../vercel-config.cjs');
const handler = require('../api');

test('Vercel gives the catch-all function enough time to finish one paid generation', () => {
  const config = createVercelConfig({ MEHFIL_SHARE_URL: 'https://share.example' });
  assert.equal(typeof handler, 'function');
  assert.equal(config.builds, undefined);
  assert.equal(config.routes, undefined);
  assert.deepEqual(config.functions, {
    'api/index.js': { maxDuration: 300 }
  });
  assert.deepEqual(config.rewrites, [
    { source: '/s/:path*', destination: 'https://share.example/s/:path*' },
    { source: '/(.*)', destination: '/api/index.js' }
  ]);
});

test('Vercel configuration exports only schema properties', async () => {
  const deployedModule = await import('../vercel.mjs');
  assert.deepEqual(Object.keys(deployedModule), ['config']);
  assert.deepEqual(Object.keys(deployedModule.config).sort(), ['functions', 'rewrites']);
});

test('Vercel leaves the share route disabled without a valid Worker origin', () => {
  assert.deepEqual(createVercelConfig({}).rewrites, [
    { source: '/(.*)', destination: '/api/index.js' }
  ]);
  assert.deepEqual(createVercelConfig({ MEHFIL_SHARE_URL: 'https://share.example/path' }).rewrites, [
    { source: '/(.*)', destination: '/api/index.js' }
  ]);
});
