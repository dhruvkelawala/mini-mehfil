const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../vercel.json');
const handler = require('../api');

test('Vercel gives the catch-all function enough time to finish one paid generation', () => {
  assert.equal(typeof handler, 'function');
  assert.equal(config.builds, undefined);
  assert.equal(config.routes, undefined);
  assert.deepEqual(config.functions, {
    'api/index.js': { maxDuration: 300 }
  });
  assert.deepEqual(config.rewrites, [{ source: '/(.*)', destination: '/api/index.js' }]);
});
