const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

async function withServer(fetchImpl, run, options = {}) {
  const server = createServer({ fetchImpl, apiBase: 'https://mock.minimax.test', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('serves the app', async () => {
  await withServer(global.fetch, async base => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /महफ़िल/);
  });
});

test('rejects an empty token without contacting MiniMax', async () => {
  let contacted = false;
  await withServer(async () => { contacted = true; }, async base => {
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lyrics: 'hello' })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Add your MiniMax API token.');
    assert.equal(contacted, false);
  });
});

test('proxies the token and normalized Music 3 payload', async () => {
  let captured;
  const mockFetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      data: { audio: 'https://cdn.example/song.mp3', status: 2 },
      base_resp: { status_code: 0, status_msg: 'success' }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer(mockFetch, async base => {
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'sk-cp-secret', lyrics: '[Verse]\nઆ સાંજ', prompt: 'Gujarati indie pop' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.audio, 'https://cdn.example/song.mp3');
  });
  assert.equal(captured.url, 'https://mock.minimax.test/v1/music_generation');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-cp-secret');
  assert.equal(captured.body.model, 'music-3.0');
  assert.equal(captured.body.output_format, 'url');
  assert.equal(captured.body.lyrics, '[Verse]\nઆ સાંજ');
});

test('does not cache or expose the token in responses', async () => {
  const mockFetch = async () => new Response(JSON.stringify({ base_resp: { status_code: 1001, status_msg: 'invalid token' } }), { status: 200 });
  await withServer(mockFetch, async base => {
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'sk-cp-never-return-this', lyrics: 'test' })
    });
    const text = await response.text();
    assert.equal(response.status, 400);
    assert.doesNotMatch(text, /never-return-this/);
  });
});

const SHEET = {
  title: 'Aloopuri Khavsa',
  language: 'Gujarati',
  languageCode: 'gu',
  nativeScriptName: 'Gujarati',
  isLatinScript: false,
  lyricsNative: '[Verse]\nઆ સાંજ ધીમે',
  lyricsRoman: '[Verse]\naa saanj dhime',
  prompt: 'Gujarati hip hop, upbeat, brass stabs, male vocal, native pronunciation.'
};

test('writes lyrics from keywords and returns both scripts', async () => {
  let seen;
  await withServer(global.fetch, async base => {
    const response = await fetch(`${base}/api/write-lyrics`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'sk-test', idea: 'Aloopuri Khavsa', vibe: 'hip hop', language: 'auto' })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.language, 'Gujarati');
    assert.equal(body.isLatinScript, false);
    assert.match(body.lyricsNative, /\[Verse\]/);
    assert.match(body.lyricsRoman, /aa saanj/);
    assert.ok(body.prompt.length > 20, 'expands the vibe into a production prompt');
    assert.equal(seen.token, 'sk-test');
    assert.equal(seen.idea, 'Aloopuri Khavsa');
    assert.equal(seen.language, 'auto');
  }, { writeLyrics: async args => { seen = args; return SHEET; } });
});

test('rejects a lyric request with no idea without calling the lyricist', async () => {
  let called = false;
  await withServer(global.fetch, async base => {
    const response = await fetch(`${base}/api/write-lyrics`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'sk-test', idea: '   ' })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Tell me what the song is about.');
    assert.equal(called, false);
  }, { writeLyrics: async () => { called = true; return SHEET; } });
});

test('rejects a lyric request with no token', async () => {
  await withServer(global.fetch, async base => {
    const response = await fetch(`${base}/api/write-lyrics`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: 'Aloopuri Khavsa' })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Add your MiniMax API token.');
  }, { writeLyrics: async () => SHEET });
});

test('surfaces a lyricist failure as a readable message', async () => {
  await withServer(global.fetch, async base => {
    const response = await fetch(`${base}/api/write-lyrics`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'sk-test', idea: 'Aloopuri Khavsa' })
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /could not read/i);
  }, { writeLyrics: async () => { throw Object.assign(new Error('The lyricist replied in a format I could not read. Try again.'), { status: 502 }); } });
});

test('rejects lyrics longer than the MiniMax ceiling', async () => {
  let contacted = false;
  await withServer(async () => { contacted = true; }, async base => {
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'sk-test', lyrics: 'x'.repeat(3001) })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /3,000 characters/);
    assert.equal(contacted, false);
  });
});
