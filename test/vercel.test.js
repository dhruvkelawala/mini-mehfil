const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../vercel.json');
const handler = require('../api');

test('Vercel has an explicit function build and catch-all route', () => {
  assert.equal(typeof handler, 'function');
  assert.deepEqual(config.builds, [{ src: 'api/index.js', use: '@vercel/node' }]);
  assert.deepEqual(config.routes, [{ src: '/(.*)', dest: '/api/index.js' }]);
});
