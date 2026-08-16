const test = require('node:test');
const assert = require('node:assert/strict');
const serverModule = require('../server');
const { issueShareTicket } = require('../share-ticket');
const { createServer } = serverModule;

test('exports an HTTP server for serverless runtimes', () => {
  assert.equal(typeof serverModule.listen, 'function');
  assert.equal(typeof serverModule.emit, 'function');
  assert.equal(typeof serverModule.createServer, 'function');
});

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

test('serves the app root when diagnostics use a query string', async () => {
  await withServer(global.fetch, async base => {
    const response = await fetch(`${base}/?mediaDebug=1`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /media-diagnostics\.js/);
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

test('shares a server-issued recording across isolated server instances and forwards no token', async () => {
  let uploaded;
  const fetchedAudio = [];
  const mockFetch = async (url, init = {}) => {
    if (url === 'https://mock.minimax.test/v1/music_generation') {
      return new Response(JSON.stringify({
        data: { audio: 'https://cdn.minimax.test/song.mp3', status: 2 },
        base_resp: { status_code: 0, status_msg: 'success' }
      }), { status: 200 });
    }
    if (url === 'https://cdn.minimax.test/song.mp3') {
      fetchedAudio.push(url);
      return new Response(new Uint8Array([73, 68, 51]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    if (url === 'https://share.example/shares') {
      uploaded = {
        metadata: JSON.parse(init.body.get('metadata')),
        audio: new Uint8Array(await init.body.get('audio').arrayBuffer()),
        headers: init.headers
      };
      return new Response(JSON.stringify({ url: 'https://share.example/s/AbCdEfGhIjKlMnOp' }), { status: 201 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  let shareReference;
  await withServer(mockFetch, async base => {
    const generated = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'sk-cp-never-upload', lyrics: '[Verse]\nઆ સાંજ', prompt: 'Gujarati indie pop' })
    });
    const song = await generated.json();
    assert.equal(typeof song.share_ref, 'string');
    assert.ok(song.share_ref.length > 24);
    shareReference = song.share_ref;
  }, { shareBaseUrl: 'https://share.example', shareSecret: 'worker-upload-secret' });

  await withServer(mockFetch, async base => {
    const shared = await fetch(`${base}/api/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shareRef: shareReference,
        token: 'sk-cp-never-upload',
        title: 'Aloopuri Khavsa',
        language: 'Gujarati',
        nativeScriptName: 'Gujarati',
        isLatinScript: false,
        lyricsNative: '[Verse]\nઆ સાંજ',
        lyricsRoman: '[Verse]\naa saanj'
      })
    });
    assert.equal(shared.status, 201);
    assert.equal((await shared.json()).url, 'https://share.example/s/AbCdEfGhIjKlMnOp');
  }, { shareBaseUrl: 'https://share.example', shareSecret: 'worker-upload-secret' });

  assert.deepEqual(uploaded.audio, new Uint8Array([73, 68, 51]));
  assert.equal(uploaded.metadata.title, 'Aloopuri Khavsa');
  assert.equal(uploaded.metadata.lyricsNative, '[Verse]\nઆ સાંજ');
  assert.equal(uploaded.metadata.lyricsRoman, '[Verse]\naa saanj');
  assert.equal(uploaded.metadata.token, undefined);
  assert.equal(uploaded.headers.Authorization, 'Bearer worker-upload-secret');
  assert.match(uploaded.headers['Idempotency-Key'], /^[A-Za-z0-9_-]{24}$/);
  assert.deepEqual(fetchedAudio, ['https://cdn.minimax.test/song.mp3']);
  assert.doesNotMatch(JSON.stringify(uploaded), /never-upload/);
});

test('does not fetch arbitrary audio for an unknown share reference', async () => {
  let contacted = false;
  await withServer(async () => { contacted = true; }, async base => {
    const response = await fetch(`${base}/api/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareRef: 'invented', title: 'Nope' })
    });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /no longer ready/);
  }, { shareBaseUrl: 'https://share.example', shareSecret: 'worker-upload-secret' });
  assert.equal(contacted, false);
});

test('rejects tampered, wrong-secret, and expired tickets without fetching', async () => {
  const now = Date.now();
  const tickets = [
    issueShareTicket({ source: 'https://cdn.minimax.test/song.mp3', expiresAt: now + 60_000, secret: 'worker-upload-secret' }),
    issueShareTicket({ source: 'https://cdn.minimax.test/song.mp3', expiresAt: now + 60_000, secret: 'different-worker-secret' }),
    issueShareTicket({ source: 'https://cdn.minimax.test/song.mp3', expiresAt: now - 1, secret: 'worker-upload-secret' })
  ];
  tickets[0] = `${tickets[0].slice(0, -1)}${tickets[0].endsWith('A') ? 'B' : 'A'}`;

  let contacted = false;
  await withServer(async () => { contacted = true; }, async base => {
    for (const shareRef of tickets) {
      const response = await fetch(`${base}/api/share`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shareRef })
      });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, 'That recording is no longer ready to share. Make it again and retry.');
    }
  }, { shareBaseUrl: 'https://share.example', shareSecret: 'worker-upload-secret' });
  assert.equal(contacted, false);
});

test('explains when sharing is not configured', async () => {
  for (const options of [{}, { shareBaseUrl: 'https://share.example' }, { shareSecret: 'worker-upload-secret' }]) {
    let contacted = false;
    await withServer(async () => { contacted = true; }, async base => {
      const response = await fetch(`${base}/api/share`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /not configured/);
    }, options);
    assert.equal(contacted, false);
  }
});

test('does not issue share references unless URL and secret are both configured', async () => {
  const mockFetch = async () => new Response(JSON.stringify({
    data: { audio: 'https://cdn.minimax.test/song.mp3', status: 2 },
    base_resp: { status_code: 0, status_msg: 'success' }
  }), { status: 200 });
  for (const options of [{ shareBaseUrl: 'https://share.example' }, { shareSecret: 'worker-upload-secret' }]) {
    await withServer(mockFetch, async base => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'sk-test', lyrics: 'No share reference' })
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).share_ref, undefined);
    }, options);
  }
});

test('keeps inline audio available without issuing a share reference', async () => {
  const mockFetch = async () => new Response(JSON.stringify({
    data: { audio: '494433', status: 2 },
    base_resp: { status_code: 0, status_msg: 'success' }
  }), { status: 200 });

  await withServer(mockFetch, async base => {
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'sk-test', lyrics: 'Keep this local' })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.data.audio, '494433');
    assert.equal(result.share_ref, undefined);
  }, { shareBaseUrl: 'https://share.example', shareSecret: 'worker-upload-secret' });
});

test('surfaces share upload failures so the same recording can be retried', async () => {
  let attempts = 0;
  const idempotencyKeys = [];
  const mockFetch = async (url, init = {}) => {
    if (url === 'https://mock.minimax.test/v1/music_generation') {
      return new Response(JSON.stringify({
        data: { audio: 'https://cdn.minimax.test/retry.mp3', status: 2 },
        base_resp: { status_code: 0, status_msg: 'success' }
      }), { status: 200 });
    }
    if (url === 'https://cdn.minimax.test/retry.mp3') {
      return new Response(new Uint8Array([73, 68, 51]), { status: 200 });
    }
    if (url === 'https://share.example/shares') {
      attempts += 1;
      idempotencyKeys.push(init.headers['Idempotency-Key']);
      if (attempts === 1) return new Response(JSON.stringify({ error: 'The bucket is having a quiet moment.' }), { status: 503 });
      return new Response(JSON.stringify({ url: 'https://share.example/s/AbCdEfGhIjKlMnOp' }), { status: 201 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withServer(mockFetch, async base => {
    const generated = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'sk-test', lyrics: 'Retry this song' })
    });
    const { share_ref: shareRef } = await generated.json();
    const payload = JSON.stringify({
      shareRef, title: 'Retry Song', language: 'English', isLatinScript: true,
      lyricsNative: 'Retry this song', lyricsRoman: 'Retry this song'
    });
    const first = await fetch(`${base}/api/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    assert.equal(first.status, 503);
    assert.match((await first.json()).error, /quiet moment/);
    const retry = await fetch(`${base}/api/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    assert.equal(retry.status, 201);
    const lostResponseRetry = await fetch(`${base}/api/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    assert.equal(lostResponseRetry.status, 201);
    assert.equal((await lostResponseRetry.json()).url, 'https://share.example/s/AbCdEfGhIjKlMnOp');
  }, { shareBaseUrl: 'https://share.example', shareSecret: 'worker-upload-secret' });
  assert.equal(attempts, 3);
  assert.equal(new Set(idempotencyKeys).size, 1);
  assert.match(idempotencyKeys[0], /^[A-Za-z0-9_-]{24}$/);
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
      body: JSON.stringify({ token: 'sk-test', lyrics: 'x'.repeat(3501) })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /3,500 characters/);
    assert.equal(contacted, false);
  });
});
