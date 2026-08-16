const test = require('node:test');
const assert = require('node:assert/strict');
const recovery = require('../public/generation-recovery.js');

const JOB_ID = 'AbCdEfGhIjKlMnOpQrStUvWx';
const SHEET = {
  title: 'Monsoon Song', language: 'Gujarati', languageCode: 'gu', nativeScriptName: 'Gujarati',
  isLatinScript: false, lyricsNative: 'વરસાદ', lyricsRoman: 'varsaad', prompt: 'Warm monsoon folk'
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    values
  };
}

test('job IDs use 18 cryptographic bytes and match the exact contract', () => {
  let requested;
  const id = recovery.createJobId({ getRandomValues(bytes) { requested = bytes.length; bytes.set(Array.from({ length: 18 }, (_, i) => i)); } });
  assert.equal(requested, 18);
  assert.match(id, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(id, 'AAECAwQFBgcICQoLDA0ODxAR');
});

test('pending session records round trip only whitelisted recovery fields', () => {
  const storage = memoryStorage();
  const coordinator = recovery.create({ storage, now: () => Date.parse('2026-08-15T12:00:00Z') });
  coordinator.save({ version: 99, jobId: JOB_ID, createdAt: 'ignored', lyricSheet: { ...SHEET, token: 'secret' }, token: 'secret', idea: 'private', vibe: 'private', audio: 'private' });
  assert.deepEqual(coordinator.read(), {
    version: 1, jobId: JOB_ID, createdAt: '2026-08-15T12:00:00.000Z', lyricSheet: SHEET
  });
  assert.doesNotMatch(storage.values.values().next().value, /secret|private/);
});

test('invalid, corrupt, version-mismatched, and expired records are cleared', () => {
  const storage = memoryStorage();
  const coordinator = recovery.create({ storage, now: () => Date.parse('2026-08-16T12:00:00.001Z') });
  for (const value of ['{', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, jobId: 'bad', createdAt: '2026-08-15T12:00:00Z', lyricSheet: SHEET }), JSON.stringify({ version: 1, jobId: JOB_ID, createdAt: '2026-08-15T12:00:00Z', lyricSheet: SHEET })]) {
    storage.setItem(recovery.STORAGE_KEY, value);
    assert.equal(coordinator.read(), null);
    assert.equal(storage.getItem(recovery.STORAGE_KEY), null);
  }
});

test('polling is visible-only, single-loop, bounded, and finalizes once', async () => {
  let visible = false;
  const scheduled = [];
  const completed = [];
  const responses = [
    { status: 'pending' }, { status: 'pending' },
    { status: 'complete', data: { audio: 'https://cdn.example/song.mp3' } }
  ];
  const coordinator = recovery.create({
    visibility: () => visible,
    fetchStatus: async () => ({ ok: true, status: 200, value: responses.shift() }),
    schedule(fn, delay) { scheduled.push({ fn, delay }); return scheduled.length; },
    cancelSchedule() {},
    onComplete: value => completed.push(value)
  });
  const pending = { jobId: JOB_ID };
  coordinator.start(pending, 1);
  coordinator.start(pending, 1);
  assert.equal(scheduled.length, 0);
  visible = true;
  coordinator.resume();
  await new Promise(setImmediate);
  assert.equal(scheduled[0].delay, 2000);
  scheduled.shift().fn();
  await new Promise(setImmediate);
  assert.equal(scheduled[0].delay, 3000);
  scheduled.shift().fn();
  await new Promise(setImmediate);
  assert.equal(completed.length, 1);
  coordinator.resume();
  await new Promise(setImmediate);
  assert.equal(completed.length, 1);
});

test('retryable failures retain state and cancellation blocks stale finalization', async () => {
  const retryable = [];
  let resolveStatus;
  const completed = [];
  const coordinator = recovery.create({
    visibility: () => true,
    fetchStatus: () => new Promise(resolve => { resolveStatus = resolve; }),
    onRetryable: error => retryable.push(error),
    onComplete: value => completed.push(value)
  });
  coordinator.start({ jobId: JOB_ID }, 1);
  await new Promise(setImmediate);
  coordinator.cancel();
  resolveStatus({ ok: true, status: 200, value: { status: 'complete', data: { audio: 'stale' } } });
  await new Promise(setImmediate);
  assert.equal(completed.length, 0);

  const failing = recovery.create({
    visibility: () => true,
    fetchStatus: async () => ({ ok: false, status: 503, value: { error: 'Try later' } }),
    onRetryable: error => retryable.push(error)
  });
  failing.start({ jobId: JOB_ID }, 2);
  await new Promise(setImmediate);
  assert.equal(retryable.at(-1).status, 503);
  assert.equal(failing.current().jobId, JOB_ID);
});

test('failed and missing jobs stop with phase-specific callbacks', async () => {
  const events = [];
  for (const response of [
    { ok: true, status: 200, value: { status: 'failed', error: 'No song.' } },
    { ok: false, status: 404, value: { error: 'Gone.' } }
  ]) {
    const coordinator = recovery.create({
      visibility: () => true,
      fetchStatus: async () => response,
      onFailed: value => events.push(['failed', value]),
      onExpired: value => events.push(['expired', value])
    });
    coordinator.start({ jobId: JOB_ID }, 1);
    await new Promise(setImmediate);
  }
  assert.deepEqual(events.map(entry => entry[0]), ['failed', 'expired']);
});
