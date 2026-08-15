import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COURTYARD_SCENE } from '../share/courtyard.mjs';
import { createR2Storage, createShareHandler } from '../share/worker.mjs';

const ID = 'AbCdEfGhIjKlMnOp';
const SECRET = 'worker-upload-secret';
const IDEMPOTENCY_KEY = 'AbCdEfGhIjKlMnOpQrStUvWx';
const SONG = {
  title: 'Aloopuri Khavsa',
  language: 'Gujarati',
  nativeScriptName: 'Gujarati',
  isLatinScript: false,
  lyricsNative: '[Verse]\nઆ સાંજ ધીમે',
  lyricsRoman: '[Verse]\naa saanj dhime'
};

function memoryStorage() {
  const shares = new Map();
  const jobs = new Map();
  let revision = 0;
  return {
    async put(id, value) { shares.set(id, value); },
    async getMetadata(id) { return shares.get(id)?.metadata || null; },
    async getAudio(id) {
      const share = shares.get(id);
      if (!share) return null;
      return { body: share.audio, size: share.audio.byteLength, contentType: share.contentType };
    },
    async claimJob(id, record) {
      if (jobs.has(id)) return { created: false, ...jobs.get(id) };
      const entry = { record, etag: `memory-${++revision}` };
      jobs.set(id, entry);
      return { created: true, ...entry };
    },
    async getJob(id) { return jobs.get(id) || null; },
    async transitionJob(id, record, etag) {
      const current = jobs.get(id);
      if (!current || current.etag !== etag) return { conflict: true };
      const entry = { record, etag: `memory-${++revision}` };
      jobs.set(id, entry);
      return { conflict: false, ...entry };
    }
  };
}

function jobRequest(path, { method = 'GET', body, authorized = true } = {}) {
  const headers = authorized ? { authorization: `Bearer ${SECRET}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://share.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function uploadFormRequest(form, headers = {}) {
  const requestHeaders = new Headers({
    authorization: `Bearer ${SECRET}`,
    'idempotency-key': IDEMPOTENCY_KEY
  });
  for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
  return new Request('https://share.example/shares', { method: 'POST', body: form, headers: requestHeaders });
}

function uploadRequest(audio = new Uint8Array([73, 68, 51]), metadata = SONG, headers = {}) {
  const form = new FormData();
  form.set('audio', new Blob([audio], { type: 'audio/mpeg' }), 'song.mp3');
  form.set('metadata', JSON.stringify(metadata));
  return uploadFormRequest(form, headers);
}

test('shared playback uses the exact courtyard artwork from the app', () => {
  const app = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const start = app.indexOf('  <div class="scene"');
  const end = app.indexOf('  <div class="grain"', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.equal(COURTYARD_SCENE.trim(), app.slice(start, end).trim());
});

test('upload to playback round trip preserves title, language, and both lyric scripts', async () => {
  const handle = createShareHandler({
    storage: memoryStorage(),
    idGenerator: () => ID,
    uploadSecret: SECRET,
    previewImageUrl: 'https://share.example/preview.png'
  });
  const upload = await handle(uploadRequest());
  assert.equal(upload.status, 201);
  assert.deepEqual(await upload.json(), { id: ID, url: `https://share.example/s/${ID}` });

  const page = await handle(new Request(`https://share.example/s/${ID}`));
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(html, /Aloopuri Khavsa/);
  assert.match(html, /Gujarati · Gujarati/);
  assert.match(html, /આ સાંજ ધીમે/);
  assert.match(html, /aa saanj dhime/);
  assert.match(html, /Make your own song/);
  assert.match(html, /class="scene"/);
  assert.match(html, /viewBox="0 0 1600 1000"/);
  assert.match(html, /class="performance"/);
  assert.match(html, /class="player-shell"/);
  assert.match(html, /class="record-label">M</);
  assert.match(html, /id="seek"/);
  assert.match(html, /id="timecode"/);
  assert.match(html, /id="replay"/);
  assert.doesNotMatch(html, /<audio[^>]+controls/);
  assert.doesNotMatch(html, /class="courtyard"/);
  assert.match(html, /property="og:url" content="https:\/\/share\.example\/s\/AbCdEfGhIjKlMnOp"/);
  assert.match(html, /property="og:audio" content="https:\/\/share\.example\/s\/AbCdEfGhIjKlMnOp\/audio"/);
  assert.match(html, /property="og:audio:type" content="audio\/mpeg"/);
  assert.match(html, /name="twitter:card" content="player"/);
  assert.match(html, /name="twitter:image" content="https:\/\/share\.example\/preview\.png"/);

  const audio = await handle(new Request(`https://share.example/s/${ID}/audio`));
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.equal(audio.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), new Uint8Array([73, 68, 51]));
});

test('rejects audio over 10 MB', async () => {
  const handle = createShareHandler({ storage: memoryStorage(), idGenerator: () => ID, uploadSecret: SECRET });
  const response = await handle(uploadRequest(new Uint8Array(10 * 1024 * 1024 + 1)));
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /10 MB/);
});

test('rejects unsupported content types', async () => {
  const form = new FormData();
  form.set('audio', new Blob(['not audio'], { type: 'text/plain' }), 'notes.txt');
  form.set('metadata', JSON.stringify(SONG));
  const handle = createShareHandler({ storage: memoryStorage(), idGenerator: () => ID, uploadSecret: SECRET });
  const response = await handle(uploadFormRequest(form));
  assert.equal(response.status, 415);
  assert.match((await response.json()).error, /Only MP3/);
});

test('rejects non-object metadata without leaking an internal error', async () => {
  const form = new FormData();
  form.set('audio', new Blob(['audio'], { type: 'audio/mpeg' }), 'song.mp3');
  form.set('metadata', 'null');
  const handle = createShareHandler({ storage: memoryStorage(), idGenerator: () => ID, uploadSecret: SECRET });
  const response = await handle(uploadFormRequest(form));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Invalid song details.');
});

test('rate limits uploads by the caller key before reading the body', async () => {
  let seen;
  const handle = createShareHandler({
    storage: memoryStorage(),
    idGenerator: () => ID,
    uploadSecret: SECRET,
    rateLimit: async key => { seen = key; return false; }
  });
  const response = await handle(uploadRequest(undefined, SONG, { 'cf-connecting-ip': '203.0.113.8' }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(seen, '203.0.113.8');
});

test('unknown ids receive the graceful missing-song page', async () => {
  const handle = createShareHandler({ storage: memoryStorage() });
  const response = await handle(new Request(`https://share.example/s/${ID}`));
  assert.equal(response.status, 404);
  assert.match(await response.text(), /This song has left the mehfil/);
});

test('rejects unauthenticated uploads before rate limiting or reading the body', async () => {
  let rateLimitCalled = false;
  const handle = createShareHandler({
    storage: memoryStorage(),
    uploadSecret: SECRET,
    rateLimit: async () => { rateLimitCalled = true; return true; }
  });
  const form = new FormData();
  form.set('audio', new Blob(['audio'], { type: 'audio/mpeg' }), 'song.mp3');
  form.set('metadata', JSON.stringify(SONG));
  const response = await handle(new Request('https://share.example/shares', { method: 'POST', body: form }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  assert.equal(rateLimitCalled, false);
});

test('derives the same unguessable share URL from retry idempotency keys', async () => {
  const handle = createShareHandler({ storage: memoryStorage(), uploadSecret: SECRET });
  const first = await handle(uploadRequest());
  const second = await handle(uploadRequest());
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstResult = await first.json();
  const secondResult = await second.json();
  assert.equal(firstResult.url, secondResult.url);
  assert.match(firstResult.id, /^[A-Za-z0-9_-]{16}$/);
});

test('stored metadata is whitelisted and never includes credentials', async () => {
  let stored;
  const storage = memoryStorage();
  const originalPut = storage.put;
  storage.put = async (id, value) => { stored = value; await originalPut(id, value); };
  const handle = createShareHandler({ storage, idGenerator: () => ID, uploadSecret: SECRET });
  const response = await handle(uploadRequest(undefined, { ...SONG, token: 'sk-cp-secret', apiKey: 'also-secret' }));
  assert.equal(response.status, 201);
  assert.equal(stored.metadata.token, undefined);
  assert.equal(stored.metadata.apiKey, undefined);
  assert.doesNotMatch(JSON.stringify(stored.metadata), /secret/);
});

test('generation jobs are claimed once and duplicate claims return the original pending record', async () => {
  const storage = memoryStorage();
  const handle = createShareHandler({ storage, uploadSecret: SECRET, now: () => Date.parse('2026-08-15T12:00:00Z') });
  const first = await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, { method: 'POST' }));
  const duplicate = await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, { method: 'POST' }));
  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), await first.json());
  const record = (await storage.getJob(IDEMPOTENCY_KEY)).record;
  assert.equal(record.status, 'pending');
  assert.equal(record.createdAt, '2026-08-15T12:00:00.000Z');
  assert.equal(record.expiresAt, '2026-08-16T12:00:00.000Z');
});

test('generation job completion is whitelisted, conditional, and idempotent', async () => {
  const storage = memoryStorage();
  const handle = createShareHandler({ storage, uploadSecret: SECRET, now: () => Date.parse('2026-08-15T12:00:00Z') });
  await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, { method: 'POST' }));
  const body = { status: 'complete', source: 'https://cdn.example/song.mp3?signature=private', traceId: 'trace-safe', token: 'secret', lyrics: 'private', prompt: 'private' };
  const completed = await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, { method: 'PUT', body }));
  assert.equal(completed.status, 200);
  const value = await completed.json();
  assert.equal(value.createdAt, '2026-08-15T12:00:00.000Z');
  assert.equal(value.source, body.source);
  assert.equal(value.traceId, 'trace-safe');
  assert.equal(value.token, undefined);
  assert.equal(value.lyrics, undefined);
  assert.equal(value.prompt, undefined);
  assert.equal((await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, { method: 'PUT', body }))).status, 200);
  assert.equal((await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, { method: 'PUT', body: { status: 'failed', error: { code: 'GENERATION_FAILED', message: 'No song.' } } }))).status, 409);
});

test('generation job routes reject invalid, expired, oversized, and unauthenticated requests without mutation', async () => {
  const storage = memoryStorage();
  let current = Date.parse('2026-08-15T12:00:00Z');
  const handle = createShareHandler({ storage, uploadSecret: SECRET, now: () => current });
  assert.equal((await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, { method: 'POST', authorized: false }))).status, 401);
  assert.equal((await handle(jobRequest('/generation-jobs/bad/claim', { method: 'POST' }))).status, 400);
  await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, { method: 'POST' }));
  assert.equal((await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, { method: 'PUT', body: { status: 'complete', source: 'x'.repeat(70 * 1024) } }))).status, 413);
  current += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`))).status, 404);
  assert.equal((await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, { method: 'PUT', body: { status: 'failed', error: { code: 'FAILED', message: 'Failed.' } } }))).status, 404);
});

test('R2 generation storage uses atomic create and handles conditional conflicts', async () => {
  const puts = [];
  let getResult = null;
  const bucket = {
    async put(key, value, options) { puts.push({ key, value: JSON.parse(value), options }); return null; },
    async get() { return getResult; }
  };
  const storage = createR2Storage(bucket);
  const record = { version: 1, jobId: IDEMPOTENCY_KEY, status: 'pending' };
  const claim = await storage.claimJob(IDEMPOTENCY_KEY, record);
  assert.equal(claim.created, false);
  assert.deepEqual(puts[0].options.onlyIf, { etagDoesNotMatch: '*' });
  getResult = { httpEtag: 'etag-1', async text() { return JSON.stringify(record); } };
  assert.deepEqual(await storage.getJob(IDEMPOTENCY_KEY), { record, etag: 'etag-1' });
  const transition = await storage.transitionJob(IDEMPOTENCY_KEY, { ...record, status: 'failed' }, 'etag-1');
  assert.equal(transition.conflict, true);
  assert.deepEqual(puts[1].options.onlyIf, { etagMatches: 'etag-1' });
});

test('R2 storage returns seekable ranges, HEAD metadata, and unsatisfiable range responses', async () => {
  const bytes = new Uint8Array([73, 68, 51, 4, 5]);
  let requestedRange;
  const bucket = {
    async head(key) {
      return key.endsWith('.mp3') ? { size: bytes.byteLength } : null;
    },
    async get(key, options = {}) {
      if (!key.endsWith('.mp3')) return null;
      requestedRange = options.range;
      const range = options.range || { offset: 0, length: bytes.byteLength };
      const body = bytes.slice(range.offset, range.offset + range.length);
      return {
        body,
        size: bytes.byteLength,
        range: options.range,
        httpEtag: '"r2-etag"',
        httpMetadata: { contentType: 'audio/mpeg' }
      };
    }
  };
  const handle = createShareHandler({ storage: createR2Storage(bucket) });

  const partial = await handle(new Request(`https://share.example/s/${ID}/audio`, { headers: { range: 'bytes=1-3' } }));
  assert.equal(partial.status, 206);
  assert.deepEqual(requestedRange, { offset: 1, length: 3 });
  assert.equal(partial.headers.get('content-range'), 'bytes 1-3/5');
  assert.equal(partial.headers.get('content-length'), '3');
  assert.equal(partial.headers.get('etag'), '"r2-etag"');
  assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), new Uint8Array([68, 51, 4]));

  const head = await handle(new Request(`https://share.example/s/${ID}/audio`, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '5');
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const unsatisfiable = await handle(new Request(`https://share.example/s/${ID}/audio`, { headers: { range: 'bytes=8-10' } }));
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */5');
  assert.equal((await unsatisfiable.arrayBuffer()).byteLength, 0);
});
