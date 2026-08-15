const test = require('node:test');
const assert = require('node:assert/strict');

const diagnostics = require('../public/media-diagnostics.js');

test('signed media URLs are reduced to their origin', () => {
  const source = 'https://cdn.example.com/private/song.mp3?AccessKey=secret&Expires=999#fragment';
  assert.equal(
    diagnostics.redactUrl(source, 'https://preview.example.app/?mediaDebug=1'),
    'https://cdn.example.com/[redacted-path]'
  );
});

test('same-origin diagnostic endpoints keep only their pathname', () => {
  assert.equal(
    diagnostics.redactUrl('/api/generate?token=secret', 'https://preview.example.app/?mediaDebug=1'),
    '/api/generate'
  );
});

test('errors retain actionable details without leaking signed URLs', () => {
  const error = new Error('Failed https://cdn.example.com/song.mp3?signature=secret');
  error.name = 'NotSupportedError';
  const normalized = diagnostics.normalizeError(error, 'https://preview.example.app/');
  assert.equal(normalized.name, 'NotSupportedError');
  assert.equal(normalized.message, 'Failed https://cdn.example.com/[redacted-path]');
  assert.doesNotMatch(JSON.stringify(normalized), /signature|secret/);
});

test('sensitive diagnostic keys are always redacted', () => {
  const details = diagnostics.safeDetails({
    token: 'sk-secret',
    requestBody: { idea: 'private idea' },
    prompt: 'private prompt',
    status: 200
  }, 'https://preview.example.app/');
  assert.deepEqual(details, {
    token: '[redacted]',
    requestBody: '[redacted]',
    prompt: '[redacted]',
    status: 200
  });
});

test('media snapshots expose WebKit state without exposing its source URL', () => {
  const snapshot = diagnostics.mediaSnapshot({
    currentSrc: 'https://cdn.example.com/private/song.mp3?signature=secret',
    paused: true,
    ended: false,
    seeking: false,
    currentTime: 0,
    duration: 6.125,
    readyState: 1,
    networkState: 2,
    error: { code: 4, message: 'Unsupported source' }
  }, 'https://preview.example.app/');
  assert.deepEqual(snapshot, {
    currentSrc: 'https://cdn.example.com/[redacted-path]',
    paused: true,
    ended: false,
    seeking: false,
    currentTime: 0,
    duration: 6.125,
    readyState: '1 HAVE_METADATA',
    networkState: '2 NETWORK_LOADING',
    error: { code: 4, message: 'Unsupported source' }
  });
});
