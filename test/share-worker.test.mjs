import test from 'node:test';
import assert from 'node:assert/strict';
import { createShareHandler } from '../share/worker.mjs';

const ID = 'AbCdEfGhIjKlMnOp';
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
  return {
    async put(id, value) { shares.set(id, value); },
    async getMetadata(id) { return shares.get(id)?.metadata || null; },
    async getAudio(id) {
      const share = shares.get(id);
      if (!share) return null;
      return { body: share.audio, size: share.audio.byteLength, contentType: share.contentType };
    }
  };
}

function uploadRequest(audio = new Uint8Array([73, 68, 51]), metadata = SONG, headers = {}) {
  const form = new FormData();
  form.set('audio', new Blob([audio], { type: 'audio/mpeg' }), 'song.mp3');
  form.set('metadata', JSON.stringify(metadata));
  return new Request('https://share.example/shares', { method: 'POST', body: form, headers });
}

test('upload to playback round trip preserves title, language, and both lyric scripts', async () => {
  const handle = createShareHandler({ storage: memoryStorage(), idGenerator: () => ID });
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

  const audio = await handle(new Request(`https://share.example/s/${ID}/audio`));
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.equal(audio.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), new Uint8Array([73, 68, 51]));
});

test('rejects audio over 10 MB', async () => {
  const handle = createShareHandler({ storage: memoryStorage(), idGenerator: () => ID });
  const response = await handle(uploadRequest(new Uint8Array(10 * 1024 * 1024 + 1)));
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /10 MB/);
});

test('rejects unsupported content types', async () => {
  const form = new FormData();
  form.set('audio', new Blob(['not audio'], { type: 'text/plain' }), 'notes.txt');
  form.set('metadata', JSON.stringify(SONG));
  const handle = createShareHandler({ storage: memoryStorage(), idGenerator: () => ID });
  const response = await handle(new Request('https://share.example/shares', { method: 'POST', body: form }));
  assert.equal(response.status, 415);
  assert.match((await response.json()).error, /Only MP3/);
});

test('rejects non-object metadata without leaking an internal error', async () => {
  const form = new FormData();
  form.set('audio', new Blob(['audio'], { type: 'audio/mpeg' }), 'song.mp3');
  form.set('metadata', 'null');
  const handle = createShareHandler({ storage: memoryStorage(), idGenerator: () => ID });
  const response = await handle(new Request('https://share.example/shares', { method: 'POST', body: form }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Invalid song details.');
});

test('rate limits uploads by the caller key before reading the body', async () => {
  let seen;
  const handle = createShareHandler({
    storage: memoryStorage(),
    idGenerator: () => ID,
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

test('stored metadata is whitelisted and never includes credentials', async () => {
  let stored;
  const storage = memoryStorage();
  const originalPut = storage.put;
  storage.put = async (id, value) => { stored = value; await originalPut(id, value); };
  const handle = createShareHandler({ storage, idGenerator: () => ID });
  const response = await handle(uploadRequest(undefined, { ...SONG, token: 'sk-cp-secret', apiKey: 'also-secret' }));
  assert.equal(response.status, 201);
  assert.equal(stored.metadata.token, undefined);
  assert.equal(stored.metadata.apiKey, undefined);
  assert.doesNotMatch(JSON.stringify(stored.metadata), /secret/);
});
