// @ts-nocheck -- This compatibility suite preserves heterogeneous HTTP fixture shapes from the pre-migration contract.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import serverModule, {
  ANALYSIS_TIMEOUT_MS,
  createServer,
  resolveDirectEntryPort,
} from '../../src/server/index.ts';
const JOB_ID = 'AbCdEfGhIjKlMnOpQrStUvWx';

test('direct entry port honors CLI precedence, environment, and defaults', () => {
  assert.equal(resolveDirectEntryPort([], undefined), 4173);
  assert.equal(resolveDirectEntryPort([], '4199'), 4199);
  assert.equal(resolveDirectEntryPort(['--port', '4200'], '4199'), 4200);
});

test('direct entry port rejects missing and invalid explicit values', () => {
  for (const args of [
    ['--port'],
    ['--port', 'nope'],
    ['--port', '1.5'],
    ['--port', '0'],
    ['--port', '65536'],
  ]) {
    assert.throws(() => resolveDirectEntryPort(args), /integer TCP port/);
  }
});

test('exports an HTTP server for serverless runtimes', () => {
  assert.equal(serverModule.listen instanceof Function, true);
  assert.equal(serverModule.emit instanceof Function, true);
  assert.equal(createServer instanceof Function, true);
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mini-mehfil-parity-'));
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><h1>महफ़िल</h1><script src="/media-diagnostics.js"></script>',
  );
  writeFileSync(join(root, 'media-diagnostics.js'), '');
  return root;
}

async function withServer(fetchImpl, run, options = {}) {
  const server = createServer({
    fetchImpl,
    apiBase: 'https://mock.minimax.test',
    staticRoot: fixtureRoot(),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('serves the app', async () => {
  await withServer(global.fetch, async (base) => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /महफ़िल/);
  });
});

test('serves the app root when diagnostics use a query string', async () => {
  await withServer(global.fetch, async (base) => {
    const response = await fetch(`${base}/?mediaDebug=1`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /media-diagnostics\.js/);
  });
});

test('allows the configured live room origin through the app CSP', async () => {
  await withServer(
    global.fetch,
    async (base) => {
      const response = await fetch(base);
      const policy = response.headers.get('content-security-policy');
      assert.match(policy, /connect-src[^;]*https:\/\/share\.example/);
      assert.match(policy, /connect-src[^;]*wss:\/\/share\.example/);
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
});

test('rejects an empty token without contacting MiniMax', async () => {
  let contacted = false;
  await withServer(
    async () => {
      contacted = true;
    },
    async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lyrics: 'hello' }),
      });
      assert.equal(response.status, 400);
      assert.equal(
        (await response.json()).error,
        'Add your MiniMax API token.',
      );
      assert.equal(contacted, false);
    },
  );
});

test('rejects malformed MiniMax tokens before contacting upstream', async () => {
  let contacted = false;
  await withServer(
    async () => {
      contacted = true;
    },
    async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          token: 'not-a-minimax-token',
          lyrics: 'hello',
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(
        (await response.json()).error,
        'MiniMax tokens start with sk-.',
      );
      assert.equal(contacted, false);
    },
  );
});

test('proxies the token and normalized Music 3 payload', async () => {
  let captured;
  const mockFetch = async (url, init) => {
    if (url === 'https://mock.minimax.test/v1/music_generation')
      captured = { url, init, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        data: { audio: 'https://cdn.example/song.mp3', status: 2 },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  await withServer(mockFetch, async (base) => {
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: 'sk-cp-secret',
        lyrics: '[Verse]\nઆ સાંજ',
        prompt: 'Gujarati indie pop',
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).data.audio,
      'https://cdn.example/song.mp3',
    );
  });
  assert.equal(captured.url, 'https://mock.minimax.test/v1/music_generation');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-cp-secret');
  assert.equal(captured.body.model, 'music-3.0');
  assert.equal(captured.body.output_format, 'url');
  assert.equal(captured.body.lyrics, '[Verse]\nઆ સાંજ');
});

test('does not cache or expose the token in responses', async () => {
  const mockFetch = async () =>
    new Response(
      JSON.stringify({
        base_resp: { status_code: 1001, status_msg: 'invalid token' },
      }),
      { status: 200 },
    );
  await withServer(mockFetch, async (base) => {
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: 'sk-cp-never-return-this',
        lyrics: 'test',
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 400);
    assert.doesNotMatch(text, /never-return-this/);
  });
});

const SECTION_SEGMENTS = [
  { start: 0, end: 12, label: 'intro' },
  { start: 12, end: 44, label: 'verse' },
  { start: 44, end: 90, label: 'chorus' },
];

function generatedSong() {
  return new Response(
    JSON.stringify({
      data: { audio: 'https://cdn.minimax.test/song.mp3', status: 2 },
      base_resp: { status_code: 0, status_msg: 'success' },
    }),
    { status: 200 },
  );
}

function preprocessed(overrides = {}) {
  return new Response(
    JSON.stringify({
      base_resp: { status_code: 0, status_msg: 'success' },
      audio_duration: 90,
      structure_result: JSON.stringify({ segments: SECTION_SEGMENTS }),
      formatted_lyrics: 'raw ASR transcript that must never leave the server',
      cover_feature_id: 'feature-1234',
      trace_id: 'trace-5678',
      ...overrides,
    }),
    { status: 200 },
  );
}

async function generateWith(mockFetch, options = {}) {
  let response;
  await withServer(
    mockFetch,
    async (base) => {
      response = await (
        await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: 'sk-cp-analysis',
            lyrics: '[Verse]\nઆ સાંજ',
            prompt: 'Gujarati indie pop',
            lyric_timing: { version: 1, mode: 'browser-forgery' },
          }),
        })
      ).json();
    },
    options,
  );
  return response;
}

async function analyzeWith(mockFetch, body = {}, options = {}) {
  let response;
  await withServer(
    mockFetch,
    async (base) => {
      response = await (
        await fetch(`${base}/api/analyze-timing`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: 'sk-cp-analysis',
            source: 'https://cdn.minimax.test/song.mp3',
            ...body,
          }),
        })
      ).json();
    },
    options,
  );
  return response;
}

test('generation returns finished audio without invoking timing analysis', async () => {
  let preprocessCalls = 0;
  const song = await generateWith(async (url) => {
    if (url === 'https://mock.minimax.test/v1/music_generation')
      return generatedSong();
    if (url === 'https://mock.minimax.test/v1/music_cover_preprocess') {
      preprocessCalls += 1;
      return preprocessed();
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  assert.equal(song.data.audio, 'https://cdn.minimax.test/song.mp3');
  assert.equal(song.lyric_timing, undefined);
  assert.equal(preprocessCalls, 0);
});

test('analysis uses a 180 second attempt and returns only normalized timing', async () => {
  assert.equal(ANALYSIS_TIMEOUT_MS, 180_000);
  let preprocess;
  const outcome = await analyzeWith(async (url, init) => {
    if (url !== 'https://mock.minimax.test/v1/music_cover_preprocess')
      throw new Error(`Unexpected URL: ${url}`);
    preprocess = { init, body: JSON.parse(init.body) };
    return preprocessed({
      audio_duration: 90,
      structure_result: JSON.stringify({
        segments: [
          { start: 0, end: 30, label: 'verse' },
          { start: 30, end: 45, label: 'pre-chorus' },
          { start: 45, end: 90, label: 'chorus' },
        ],
      }),
    });
  }, {});

  assert.deepEqual(outcome.timing?.segments, [
    { start: 0, end: 30, label: 'verse' },
    { start: 30, end: 45, label: 'verse' },
    { start: 45, end: 90, label: 'chorus' },
  ]);
  assert.equal(preprocess.init.headers.Authorization, 'Bearer sk-cp-analysis');
  assert.equal(preprocess.body.model, 'music-cover');
  assert.equal(preprocess.body.audio_url, 'https://cdn.minimax.test/song.mp3');
  const serialized = JSON.stringify(outcome);
  assert.doesNotMatch(serialized, /formatted_lyrics|raw ASR transcript/);
  assert.doesNotMatch(serialized, /cover_feature_id|feature-1234/);
  assert.doesNotMatch(serialized, /trace-5678|sk-cp-analysis|cdn\.minimax/);
});

test('analysis returns discriminated terminal outcomes for untrusted results', async () => {
  const unusable = {
    'a rejected request': {
      reply: () => new Response('nope', { status: 401 }),
      expected: { reason: 'authentication', retryable: false },
    },
    'an upstream status code': () =>
      preprocessed({ base_resp: { status_code: 1002, status_msg: 'busy' } }),
    'an unreadable body': () => new Response('not json', { status: 200 }),
    'a malformed structure_result': () =>
      preprocessed({ structure_result: '{{{' }),
    'a non-string structure_result': () =>
      preprocessed({ structure_result: { segments: SECTION_SEGMENTS } }),
    'segments outside the audio': () =>
      preprocessed({
        structure_result: JSON.stringify({
          segments: [{ start: 0, end: 900, label: 'verse' }],
        }),
      }),
    'an unknown label': () =>
      preprocessed({
        structure_result: JSON.stringify({
          segments: [{ start: 0, end: 12, label: 'karaoke' }],
        }),
      }),
    'a missing duration': () => preprocessed({ audio_duration: undefined }),
  };

  for (const [name, entry] of Object.entries(unusable)) {
    const reply = entry.reply ?? entry;
    const outcome = await analyzeWith(async (url) => {
      if (url !== 'https://mock.minimax.test/v1/music_cover_preprocess')
        throw new Error(`Unexpected URL: ${url}`);
      return reply();
    });
    assert.equal(outcome.status, 'unavailable', name);
    if (entry.expected) {
      assert.equal(outcome.reason, entry.expected.reason, name);
      assert.equal(outcome.retryable, entry.expected.retryable, name);
    } else if (name === 'an upstream status code') {
      assert.equal(outcome.reason, 'provider-busy', name);
      assert.equal(outcome.retryable, true, name);
    } else {
      assert.equal(outcome.retryable, false, name);
    }
  }
});

test('a hung analysis returns a retryable timeout outcome', async () => {
  const outcome = await analyzeWith(
    async (url, init) => {
      if (url === 'https://mock.minimax.test/v1/music_cover_preprocess') {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(init.signal.reason),
          );
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    {},
    { analysisTimeoutMs: 25 },
  );
  assert.deepEqual(outcome, {
    status: 'unavailable',
    reason: 'timeout',
    retryable: true,
  });
});

test('rejects inline analysis and never trusts generation timing fields', async () => {
  let preprocessCalls = 0;
  const song = await generateWith(async (url) => {
    if (url === 'https://mock.minimax.test/v1/music_generation') {
      return new Response(
        JSON.stringify({
          data: { audio: '49443304' },
          base_resp: { status_code: 0, status_msg: 'success' },
          lyric_timing: {
            version: 1,
            mode: 'minimax-section-asr',
            durationSeconds: 90,
            segments: SECTION_SEGMENTS,
          },
        }),
        { status: 200 },
      );
    }
    if (url === 'https://mock.minimax.test/v1/music_cover_preprocess') {
      preprocessCalls += 1;
      return preprocessed();
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  assert.equal(preprocessCalls, 0);
  assert.equal(song.lyric_timing, undefined);

  const outcome = await analyzeWith(
    async () => {
      preprocessCalls += 1;
      return preprocessed();
    },
    { source: '49443304' },
  );
  assert.deepEqual(outcome, {
    status: 'unavailable',
    reason: 'unsupported-source',
    retryable: false,
  });
  assert.equal(preprocessCalls, 0);
});

test('loopback replay sources require the explicit server test seam', async () => {
  const source = 'http://127.0.0.1:4387/__fixture/song.mp3';
  let generationCalls = 0;
  let timingCalls = 0;
  const replayFetch = async (url) => {
    if (url === 'https://mock.minimax.test/v1/music_generation') {
      generationCalls += 1;
      return new Response(
        JSON.stringify({
          data: { audio: source },
          base_resp: { status_code: 0, status_msg: 'success' },
        }),
      );
    }
    if (url === 'https://mock.minimax.test/v1/music_cover_preprocess') {
      timingCalls += 1;
      return preprocessed();
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  assert.equal((await generateWith(replayFetch)).error.includes('audio'), true);
  assert.deepEqual(await analyzeWith(replayFetch, { source }), {
    status: 'unavailable',
    reason: 'unsupported-source',
    retryable: false,
  });
  assert.equal(timingCalls, 0);

  const generated = await generateWith(replayFetch, {
    allowLocalHttpAudioSource: true,
  });
  assert.equal(generated.data.audio, source);
  const analyzed = await analyzeWith(
    replayFetch,
    { source },
    { allowLocalHttpAudioSource: true },
  );
  assert.equal(analyzed.status, 'ready');
  assert.equal(generationCalls, 2);
  assert.equal(timingCalls, 1);
});

test('generation recovery checkpoints audio without waiting for timing', async () => {
  let uploaded;
  let job;
  const mockFetch = async (url, init = {}) => {
    if (url === `https://share.example/generation-jobs/${JOB_ID}/claim`) {
      job = job || { version: 1, jobId: JOB_ID, status: 'pending' };
      return new Response(JSON.stringify(job), { status: 201 });
    }
    if (
      url === `https://share.example/generation-jobs/${JOB_ID}` &&
      init.method === 'PUT'
    ) {
      job = { version: 1, jobId: JOB_ID, ...JSON.parse(init.body) };
      return new Response(JSON.stringify(job));
    }
    if (url === `https://share.example/generation-jobs/${JOB_ID}`)
      return new Response(JSON.stringify(job));
    if (url === 'https://mock.minimax.test/v1/music_generation')
      return generatedSong();
    if (url === 'https://mock.minimax.test/v1/music_cover_preprocess')
      return preprocessed();
    if (url === 'https://cdn.minimax.test/song.mp3') {
      return new Response(new Uint8Array([73, 68, 51]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    }
    if (url === 'https://share.example/shares') {
      uploaded = { metadata: JSON.parse(init.body.get('metadata')) };
      return new Response(
        JSON.stringify({ url: 'https://share.example/s/AbCdEfGhIjKlMnOp' }),
        { status: 201 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withServer(
    mockFetch,
    async (base) => {
      const song = await (
        await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobId: JOB_ID,
            token: 'sk-cp-analysis',
            lyrics: '[Verse]\nઆ સાંજ',
          }),
        })
      ).json();
      assert.equal(song.lyric_timing, undefined);

      // A second reader gets the paid result immediately, still timing-free.
      const recovered = await (
        await fetch(`${base}/api/generation-status?id=${JOB_ID}`)
      ).json();
      assert.equal(recovered.lyric_timing, undefined);

      const shared = await fetch(`${base}/api/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shareRef: song.share_ref,
          title: 'Aloopuri Khavsa',
          language: 'Gujarati',
          nativeScriptName: 'Gujarati',
          isLatinScript: false,
          lyricsNative: '[Verse]\nઆ સાંજ',
          lyricsRoman: '[Verse]\naa saanj',
          lyricTiming: {
            version: 1,
            mode: 'minimax-section-asr',
            durationSeconds: 5,
            segments: [{ start: 0, end: 5, label: 'outro' }],
          },
        }),
      });
      assert.equal(shared.status, 201);
    },
    {
      shareBaseUrl: 'https://share.example',
      publicBaseUrl: 'https://minimehfil.wtf',
      shareSecret: 'worker-upload-secret',
    },
  );

  assert.deepEqual(uploaded.metadata.lyricTiming, {
    version: 1,
    mode: 'minimax-section-asr',
    durationSeconds: 5,
    segments: [{ start: 0, end: 5, label: 'outro' }],
  });
  assert.doesNotMatch(
    JSON.stringify(uploaded),
    /formatted_lyrics|feature-1234/,
  );
});

test('shares a recording with null timing when analysis produced none', async () => {
  let uploaded;
  let job;
  const mockFetch = async (url, init = {}) => {
    if (url === `https://share.example/generation-jobs/${JOB_ID}/claim`) {
      job = job || { version: 1, jobId: JOB_ID, status: 'pending' };
      return new Response(JSON.stringify(job), { status: 201 });
    }
    if (
      url === `https://share.example/generation-jobs/${JOB_ID}` &&
      init.method === 'PUT'
    ) {
      job = { version: 1, jobId: JOB_ID, ...JSON.parse(init.body) };
      return new Response(JSON.stringify(job));
    }
    if (url === `https://share.example/generation-jobs/${JOB_ID}`)
      return new Response(JSON.stringify(job));
    if (url === 'https://mock.minimax.test/v1/music_generation')
      return generatedSong();
    if (url === 'https://mock.minimax.test/v1/music_cover_preprocess')
      return new Response('nope', { status: 500 });
    if (url === 'https://cdn.minimax.test/song.mp3') {
      return new Response(new Uint8Array([73, 68, 51]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    }
    if (url === 'https://share.example/shares') {
      uploaded = { metadata: JSON.parse(init.body.get('metadata')) };
      return new Response(
        JSON.stringify({ url: 'https://share.example/s/AbCdEfGhIjKlMnOp' }),
        { status: 201 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withServer(
    mockFetch,
    async (base) => {
      const song = await (
        await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobId: JOB_ID,
            token: 'sk-cp-analysis',
            lyrics: '[Verse]\nઆ સાંજ',
          }),
        })
      ).json();
      assert.equal(song.lyric_timing, undefined);
      const shared = await fetch(`${base}/api/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shareRef: song.share_ref,
          title: 'Aloopuri Khavsa',
          language: 'Gujarati',
          nativeScriptName: 'Gujarati',
          isLatinScript: false,
          lyricsNative: '[Verse]\nઆ સાંજ',
          lyricsRoman: '[Verse]\naa saanj',
        }),
      });
      assert.equal(shared.status, 201);
    },
    {
      shareBaseUrl: 'https://share.example',
      publicBaseUrl: 'https://minimehfil.wtf',
      shareSecret: 'worker-upload-secret',
    },
  );

  assert.equal(uploaded.metadata.lyricTiming, null);
});

test('shares only server-issued recordings and forwards no token', async () => {
  let uploaded;
  let job;
  const mockFetch = async (url, init = {}) => {
    if (url === `https://share.example/generation-jobs/${JOB_ID}/claim`) {
      job = job || { version: 1, jobId: JOB_ID, status: 'pending' };
      return new Response(JSON.stringify(job), { status: 201 });
    }
    if (
      url === `https://share.example/generation-jobs/${JOB_ID}` &&
      init.method === 'PUT'
    ) {
      job = { version: 1, jobId: JOB_ID, ...JSON.parse(init.body) };
      return new Response(JSON.stringify(job));
    }
    if (url === `https://share.example/generation-jobs/${JOB_ID}`)
      return new Response(JSON.stringify(job));
    if (url === 'https://mock.minimax.test/v1/music_generation') {
      return new Response(
        JSON.stringify({
          data: { audio: 'https://cdn.minimax.test/song.mp3', status: 2 },
          base_resp: { status_code: 0, status_msg: 'success' },
        }),
        { status: 200 },
      );
    }
    if (url === 'https://cdn.minimax.test/song.mp3') {
      return new Response(new Uint8Array([73, 68, 51]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    }
    if (url === 'https://share.example/shares') {
      uploaded = {
        metadata: JSON.parse(init.body.get('metadata')),
        audio: new Uint8Array(await init.body.get('audio').arrayBuffer()),
        headers: init.headers,
      };
      return new Response(
        JSON.stringify({ url: 'https://share.example/s/AbCdEfGhIjKlMnOp' }),
        { status: 201 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withServer(
    mockFetch,
    async (base) => {
      const generated = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          token: 'sk-cp-never-upload',
          lyrics: '[Verse]\nઆ સાંજ',
          prompt: 'Gujarati indie pop',
        }),
      });
      const song = await generated.json();
      assert.match(song.share_ref, /^[A-Za-z0-9_-]{24}$/);

      const shared = await fetch(`${base}/api/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shareRef: song.share_ref,
          token: 'sk-cp-never-upload',
          title: 'Aloopuri Khavsa',
          language: 'Gujarati',
          nativeScriptName: 'Gujarati',
          isLatinScript: false,
          lyricsNative: '[Verse]\nઆ સાંજ',
          lyricsRoman: '[Verse]\naa saanj',
        }),
      });
      assert.equal(shared.status, 201);
      assert.equal(
        (await shared.json()).url,
        'https://minimehfil.wtf/s/AbCdEfGhIjKlMnOp',
      );
    },
    {
      shareBaseUrl: 'https://share.example',
      publicBaseUrl: 'https://minimehfil.wtf',
      vercelProjectProductionUrl: 'mini-mehfil.vercel.app',
      shareSecret: 'worker-upload-secret',
    },
  );

  assert.deepEqual(uploaded.audio, new Uint8Array([73, 68, 51]));
  assert.equal(uploaded.metadata.title, 'Aloopuri Khavsa');
  assert.equal(uploaded.metadata.lyricsNative, '[Verse]\nઆ સાંજ');
  assert.equal(uploaded.metadata.lyricsRoman, '[Verse]\naa saanj');
  assert.equal(uploaded.metadata.token, undefined);
  assert.equal(uploaded.headers.Authorization, 'Bearer worker-upload-secret');
  assert.match(uploaded.headers['Idempotency-Key'], /^[A-Za-z0-9_-]{24}$/);
  assert.doesNotMatch(JSON.stringify(uploaded), /never-upload/);
});

test('does not fetch arbitrary audio for an unknown share reference', async () => {
  let contacted = false;
  await withServer(
    async () => {
      contacted = true;
    },
    async (base) => {
      const response = await fetch(`${base}/api/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shareRef: 'invented', title: 'Nope' }),
      });
      assert.equal(response.status, 404);
      assert.match((await response.json()).error, /no longer ready/);
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
  assert.equal(contacted, false);
});

test('explains when sharing is not configured', async () => {
  for (const options of [
    {},
    { shareBaseUrl: 'https://share.example' },
    { shareSecret: 'worker-upload-secret' },
  ]) {
    let contacted = false;
    await withServer(
      async () => {
        contacted = true;
      },
      async (base) => {
        const response = await fetch(`${base}/api/share`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(response.status, 503);
        assert.match((await response.json()).error, /not configured/);
      },
      options,
    );
    assert.equal(contacted, false);
  }
});

test('opens a room through the configured Worker without exposing server credentials', async () => {
  let captured;
  const mockFetch = async (url, init) => {
    captured = { url, init };
    return new Response(
      JSON.stringify({
        roomId: 'ABCDEFGH',
        joinUrl: 'https://share.example/r/ABCDEFGH',
        socketUrl: 'wss://share.example/rooms/ABCDEFGH/ws',
        hostSecret: 'a'.repeat(43),
        expiresAt: Date.now() + 60000,
      }),
      { status: 201 },
    );
  };
  await withServer(
    mockFetch,
    async (base) => {
      const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
      assert.equal(response.status, 201);
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(body.roomId, 'ABCDEFGH');
      assert.doesNotMatch(
        body.joinUrl + body.socketUrl,
        /worker-upload-secret|sk-cp-/,
      );
      assert.equal(body.hostSecret.length, 43);
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
  assert.equal(captured.url, 'https://share.example/rooms');
  assert.equal(
    captured.init.headers.Authorization,
    'Bearer worker-upload-secret',
  );
  assert.equal(captured.init.body, '{}');
});

test('room creation requires sharing configuration', async () => {
  await withServer(
    async () => {
      throw new Error('not called');
    },
    async (base) => {
      const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /not configured/);
    },
  );
});

test('rejects malicious or mismatched room URLs', async () => {
  for (const patch of [
    { joinUrl: 'https://evil.example/r/ABCDEFGH' },
    { socketUrl: 'wss://share.example/rooms/ZZZZZZZZ/ws' },
    { hostSecret: 'short' },
    { expiresAt: 1 },
  ]) {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          roomId: 'ABCDEFGH',
          joinUrl: 'https://share.example/r/ABCDEFGH',
          socketUrl: 'wss://share.example/rooms/ABCDEFGH/ws',
          hostSecret: 'a'.repeat(43),
          expiresAt: Date.now() + 60000,
          ...patch,
        }),
        { status: 201 },
      );
    await withServer(
      mockFetch,
      async (base) => {
        const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
        assert.equal(response.status, 502);
        assert.doesNotMatch(
          await response.text(),
          /worker-upload-secret|sk-cp-never/,
        );
      },
      {
        shareBaseUrl: 'https://share.example',
        shareSecret: 'worker-upload-secret',
      },
    );
  }
});

test('normalizes room Worker errors', async () => {
  const mockFetch = async () =>
    new Response(JSON.stringify({ error: 'Rooms are resting.' }), {
      status: 503,
    });
  await withServer(
    mockFetch,
    async (base) => {
      const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'Rooms are resting.');
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
});

test('times out room creation without exposing credentials', async () => {
  const mockFetch = async (_url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener(
        'abort',
        () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
    });
  await withServer(
    mockFetch,
    async (base) => {
      const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
      assert.equal(response.status, 504);
      assert.equal(
        (await response.json()).error,
        'Opening the room took too long. Please retry.',
      );
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
      roomTimeoutMs: 5,
    },
  );
});

test('does not issue share references unless URL and secret are both configured', async () => {
  const mockFetch = async () =>
    new Response(
      JSON.stringify({
        data: { audio: 'https://cdn.minimax.test/song.mp3', status: 2 },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
      { status: 200 },
    );
  for (const options of [
    { shareBaseUrl: 'https://share.example' },
    { shareSecret: 'worker-upload-secret' },
  ]) {
    await withServer(
      mockFetch,
      async (base) => {
        const response = await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: 'sk-test',
            lyrics: 'No share reference',
          }),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).share_ref, undefined);
      },
      options,
    );
  }
});

test('surfaces share upload failures so the same recording can be retried', async () => {
  let attempts = 0;
  let job;
  const mockFetch = async (url, init = {}) => {
    if (url === `https://share.example/generation-jobs/${JOB_ID}/claim`) {
      job = job || { version: 1, jobId: JOB_ID, status: 'pending' };
      return new Response(JSON.stringify(job), { status: 201 });
    }
    if (
      url === `https://share.example/generation-jobs/${JOB_ID}` &&
      init.method === 'PUT'
    ) {
      job = { version: 1, jobId: JOB_ID, ...JSON.parse(init.body) };
      return new Response(JSON.stringify(job));
    }
    if (url === `https://share.example/generation-jobs/${JOB_ID}`)
      return new Response(JSON.stringify(job));
    if (url === 'https://mock.minimax.test/v1/music_generation') {
      return new Response(
        JSON.stringify({
          data: { audio: '494433', status: 2 },
          base_resp: { status_code: 0, status_msg: 'success' },
        }),
        { status: 200 },
      );
    }
    if (url === 'https://share.example/shares') {
      attempts += 1;
      if (attempts === 1)
        return new Response(
          JSON.stringify({ error: 'The bucket is having a quiet moment.' }),
          { status: 503 },
        );
      return new Response(
        JSON.stringify({ url: 'https://share.example/s/AbCdEfGhIjKlMnOp' }),
        { status: 201 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withServer(
    mockFetch,
    async (base) => {
      const generated = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          token: 'sk-test',
          lyrics: 'Retry this song',
        }),
      });
      const { share_ref: shareRef } = await generated.json();
      const payload = JSON.stringify({
        shareRef,
        title: 'Retry Song',
        language: 'English',
        isLatinScript: true,
        lyricsNative: 'Retry this song',
        lyricsRoman: 'Retry this song',
      });
      const first = await fetch(`${base}/api/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      assert.equal(first.status, 503);
      assert.match((await first.json()).error, /quiet moment/);
      const retry = await fetch(`${base}/api/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      assert.equal(retry.status, 201);
      const lostResponseRetry = await fetch(`${base}/api/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      assert.equal(lostResponseRetry.status, 201);
      assert.equal(
        (await lostResponseRetry.json()).url,
        'https://share.example/s/AbCdEfGhIjKlMnOp',
      );
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
  assert.equal(attempts, 2);
});

test('claims before one paid call, checkpoints before success, and recovers a lost response', async () => {
  const calls = [];
  let job;
  let minimaxCalls = 0;
  const mockFetch = async (url, init = {}) => {
    if (url === `https://share.example/generation-jobs/${JOB_ID}/claim`) {
      calls.push('claim');
      if (job) return new Response(JSON.stringify(job), { status: 200 });
      job = { version: 1, jobId: JOB_ID, status: 'pending' };
      return new Response(JSON.stringify(job), { status: 201 });
    }
    if (url === 'https://mock.minimax.test/v1/music_generation') {
      calls.push('minimax');
      minimaxCalls += 1;
      return new Response(
        JSON.stringify({
          data: { audio: 'https://cdn.example/song.mp3' },
          trace_id: 'safe-trace',
          base_resp: { status_code: 0 },
        }),
      );
    }
    if (
      url === `https://share.example/generation-jobs/${JOB_ID}` &&
      init.method === 'PUT'
    ) {
      calls.push('checkpoint');
      job = { version: 1, jobId: JOB_ID, ...JSON.parse(init.body) };
      return new Response(JSON.stringify(job));
    }
    if (url === `https://share.example/generation-jobs/${JOB_ID}`) {
      calls.push('status');
      return new Response(JSON.stringify(job));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  await withServer(
    mockFetch,
    async (base) => {
      const payload = {
        jobId: JOB_ID,
        token: 'sk-private',
        lyrics: 'One paid song',
        prompt: 'Warm',
      };
      const initial = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(initial.status, 200);
      const status = await fetch(`${base}/api/generation-status?id=${JOB_ID}`);
      assert.deepEqual(await status.json(), {
        jobId: JOB_ID,
        status: 'complete',
        data: { audio: 'https://cdn.example/song.mp3' },
        trace_id: 'safe-trace',
        share_ref: JOB_ID,
      });
      const duplicate = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(duplicate.status, 200);
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
  assert.deepEqual(calls.slice(0, 3), ['claim', 'minimax', 'checkpoint']);
  assert.equal(minimaxCalls, 1);
});

test('an existing pending claim returns 202 without contacting MiniMax', async () => {
  let minimaxCalls = 0;
  const mockFetch = async (url) => {
    if (url === `https://share.example/generation-jobs/${JOB_ID}/claim`)
      return new Response(
        JSON.stringify({ jobId: JOB_ID, status: 'pending' }),
        { status: 200 },
      );
    minimaxCalls += 1;
    throw new Error(`Unexpected URL: ${url}`);
  };
  await withServer(
    mockFetch,
    async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          token: 'sk-private',
          lyrics: 'Pending song',
        }),
      });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), {
        jobId: JOB_ID,
        status: 'pending',
      });
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
  assert.equal(minimaxCalls, 0);
});

test('claim failure precedes MiniMax and failed generations store only public feedback', async () => {
  let minimaxCalls = 0;
  await withServer(
    async (url) => {
      if (url.includes('/claim'))
        return new Response(JSON.stringify({ error: 'Store unavailable.' }), {
          status: 503,
        });
      minimaxCalls += 1;
    },
    async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          token: 'sk-private',
          lyrics: 'Never charged',
        }),
      });
      assert.equal(response.status, 503);
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
  assert.equal(minimaxCalls, 0);

  let checkpoint;
  await withServer(
    async (url, init = {}) => {
      if (url.includes('/claim'))
        return new Response(
          JSON.stringify({ jobId: JOB_ID, status: 'pending' }),
          { status: 201 },
        );
      if (url.includes('/generation-jobs/') && init.method === 'PUT') {
        checkpoint = JSON.parse(init.body);
        return new Response(JSON.stringify({ jobId: JOB_ID, ...checkpoint }));
      }
      return new Response(
        JSON.stringify({
          base_resp: { status_code: 1001, status_msg: 'invalid token' },
          raw: 'do-not-store',
        }),
      );
    },
    async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          token: 'sk-never-store',
          lyrics: 'private lyrics',
          prompt: 'private prompt',
        }),
      });
      assert.equal(response.status, 400);
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
  assert.deepEqual(checkpoint, {
    status: 'failed',
    error: {
      code: 'MINIMAX_FAILED',
      message: 'MiniMax rejected the API token. Check it and try again.',
    },
  });
  assert.doesNotMatch(
    JSON.stringify(checkpoint),
    /never-store|private lyrics|private prompt|do-not-store/,
  );
});

test('generation status validates IDs and explains unconfigured recovery', async () => {
  await withServer(global.fetch, async (base) => {
    assert.equal(
      (await fetch(`${base}/api/generation-status?id=bad`)).status,
      400,
    );
    const response = await fetch(`${base}/api/generation-status?id=${JOB_ID}`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /cannot recover/);
  });
});

test('a completed paid call is not reported successful when its checkpoint fails', async () => {
  let minimaxCalls = 0;
  let checkpointCalls = 0;
  const mockFetch = async (url, init = {}) => {
    if (url.endsWith('/claim'))
      return new Response(
        JSON.stringify({ jobId: JOB_ID, status: 'pending' }),
        { status: 201 },
      );
    if (url === 'https://mock.minimax.test/v1/music_generation') {
      minimaxCalls += 1;
      return new Response(
        JSON.stringify({
          data: { audio: 'https://cdn.example/song.mp3' },
          base_resp: { status_code: 0 },
        }),
      );
    }
    if (init.method === 'PUT') {
      checkpointCalls += 1;
      return new Response(JSON.stringify({ error: 'Store unavailable.' }), {
        status: 503,
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  await withServer(
    mockFetch,
    async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          token: 'sk-private',
          lyrics: 'One paid song',
        }),
      });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /checkpoint/);
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
  assert.equal(minimaxCalls, 1);
  assert.equal(checkpointCalls, 2);
});

test('a transient complete-checkpoint failure is retried without another paid call', async () => {
  let minimaxCalls = 0;
  let checkpointCalls = 0;
  const complete = {
    jobId: JOB_ID,
    status: 'complete',
    source: 'https://cdn.example/song.mp3',
  };
  const mockFetch = async (url, init = {}) => {
    if (url.endsWith('/claim'))
      return new Response(
        JSON.stringify({ jobId: JOB_ID, status: 'pending' }),
        { status: 201 },
      );
    if (url === 'https://mock.minimax.test/v1/music_generation') {
      minimaxCalls += 1;
      return new Response(
        JSON.stringify({
          data: { audio: complete.source },
          base_resp: { status_code: 0 },
        }),
      );
    }
    if (init.method === 'PUT') {
      checkpointCalls += 1;
      if (checkpointCalls === 1)
        return new Response(JSON.stringify({ error: 'Transient.' }), {
          status: 503,
        });
      return new Response(JSON.stringify(complete));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  await withServer(
    mockFetch,
    async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          token: 'sk-private',
          lyrics: 'Retry checkpoint',
        }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.audio, complete.source);
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
  assert.equal(minimaxCalls, 1);
  assert.equal(checkpointCalls, 2);
});

test('a MiniMax network failure reports retryable storage trouble when failure checkpointing also fails', async () => {
  let checkpointCalls = 0;
  const mockFetch = async (url, init = {}) => {
    if (url.endsWith('/claim'))
      return new Response(
        JSON.stringify({ jobId: JOB_ID, status: 'pending' }),
        { status: 201 },
      );
    if (url === 'https://mock.minimax.test/v1/music_generation')
      throw new Error('socket lost at https://signed.example/?secret=yes');
    if (init.method === 'PUT') {
      checkpointCalls += 1;
      return new Response(JSON.stringify({ error: 'Store unavailable.' }), {
        status: 503,
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  await withServer(
    mockFetch,
    async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          token: 'sk-private',
          lyrics: 'Network failure',
        }),
      });
      const text = await response.text();
      assert.equal(response.status, 503);
      assert.doesNotMatch(text, /signed|secret|socket/);
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
  assert.equal(checkpointCalls, 2);
});

test('a timed-out paid call checkpoints a stable failure before responding', async () => {
  let checkpoint;
  const mockFetch = async (url, init = {}) => {
    if (url.endsWith('/claim')) {
      return new Response(
        JSON.stringify({ jobId: JOB_ID, status: 'pending' }),
        { status: 201 },
      );
    }
    if (url === 'https://mock.minimax.test/v1/music_generation') {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    }
    if (
      url === `https://share.example/generation-jobs/${JOB_ID}` &&
      init.method === 'PUT'
    ) {
      checkpoint = JSON.parse(init.body);
      return new Response(JSON.stringify({ jobId: JOB_ID, ...checkpoint }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withServer(
    mockFetch,
    async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          token: 'sk-private',
          lyrics: 'A patient song',
        }),
      });
      assert.equal(response.status, 504);
      assert.equal(
        (await response.json()).error,
        'The recording took too long to finish. Try the mehfil again.',
      );
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'share-secret',
      generationTimeoutMs: 5,
    },
  );

  assert.deepEqual(checkpoint, {
    status: 'failed',
    error: {
      code: 'GENERATION_TIMEOUT',
      message: 'The recording took too long to finish. Try the mehfil again.',
    },
  });
});

test('generation status preserves pending and failed contracts and distinguishes missing storage', async () => {
  const pendingId = '111111111111111111111111';
  const failedId = '222222222222222222222222';
  const missingId = '333333333333333333333333';
  const brokenId = '444444444444444444444444';
  const states = new Map([
    [pendingId, { jobId: pendingId, status: 'pending' }],
    [
      failedId,
      {
        jobId: failedId,
        status: 'failed',
        error: { message: 'MiniMax rejected the API token.' },
      },
    ],
  ]);
  await withServer(
    async (url) => {
      const id = url.split('/').at(-1);
      if (id === missingId)
        return new Response(JSON.stringify({ error: 'Not found.' }), {
          status: 404,
        });
      if (id === brokenId)
        return new Response(JSON.stringify({ error: 'Unavailable.' }), {
          status: 503,
        });
      return new Response(JSON.stringify(states.get(id)));
    },
    async (base) => {
      const pending = await fetch(
        `${base}/api/generation-status?id=${pendingId}`,
      );
      assert.deepEqual(await pending.json(), {
        jobId: pendingId,
        status: 'pending',
      });
      const failed = await fetch(
        `${base}/api/generation-status?id=${failedId}`,
      );
      assert.deepEqual(await failed.json(), {
        jobId: failedId,
        status: 'failed',
        error: 'MiniMax rejected the API token.',
      });
      assert.equal(
        (await fetch(`${base}/api/generation-status?id=${missingId}`)).status,
        404,
      );
      assert.equal(
        (await fetch(`${base}/api/generation-status?id=${brokenId}`)).status,
        503,
      );
    },
    {
      shareBaseUrl: 'https://share.example',
      shareSecret: 'worker-upload-secret',
    },
  );
});

test('sharing resolves a completed job after the generating server process is gone', async () => {
  let job;
  let uploadedAudio;
  const mockFetch = async (url, init = {}) => {
    if (url.endsWith('/claim')) {
      job = { jobId: JOB_ID, status: 'pending' };
      return new Response(JSON.stringify(job), { status: 201 });
    }
    if (url === 'https://mock.minimax.test/v1/music_generation')
      return new Response(
        JSON.stringify({
          data: { audio: '0X494433' },
          base_resp: { status_code: 0 },
        }),
      );
    if (
      url === `https://share.example/generation-jobs/${JOB_ID}` &&
      init.method === 'PUT'
    ) {
      job = { jobId: JOB_ID, ...JSON.parse(init.body) };
      return new Response(JSON.stringify(job));
    }
    if (url === `https://share.example/generation-jobs/${JOB_ID}`)
      return new Response(JSON.stringify(job));
    if (url === 'https://share.example/shares') {
      uploadedAudio = new Uint8Array(
        await init.body.get('audio').arrayBuffer(),
      );
      return new Response(
        JSON.stringify({ url: 'https://share.example/s/AbCdEfGhIjKlMnOp' }),
        { status: 201 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const options = {
    shareBaseUrl: 'https://share.example',
    shareSecret: 'worker-upload-secret',
  };
  await withServer(
    mockFetch,
    async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: JOB_ID,
          token: 'sk-private',
          lyrics: 'Persist me',
        }),
      });
      assert.equal(response.status, 200);
    },
    options,
  );
  await withServer(
    mockFetch,
    async (base) => {
      const response = await fetch(`${base}/api/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shareRef: JOB_ID,
          title: 'Persisted',
          language: 'English',
          isLatinScript: true,
          lyricsNative: 'Persist me',
          lyricsRoman: 'Persist me',
        }),
      });
      assert.equal(response.status, 201);
    },
    options,
  );
  assert.deepEqual(uploadedAudio, new Uint8Array([73, 68, 51]));
});

const SHEET = {
  title: 'Aloopuri Khavsa',
  language: 'Gujarati',
  languageCode: 'gu',
  nativeScriptName: 'Gujarati',
  isLatinScript: false,
  lyricsNative: '[Verse]\nઆ સાંજ ધીમે',
  lyricsRoman: '[Verse]\naa saanj dhime',
  prompt:
    'Gujarati hip hop, upbeat, brass stabs, male vocal, native pronunciation.',
};

test('writes lyrics from keywords and returns both scripts', async () => {
  let seen;
  await withServer(
    global.fetch,
    async (base) => {
      const response = await fetch(`${base}/api/write-lyrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: 'sk-test',
          idea: 'Aloopuri Khavsa',
          vibe: 'hip hop',
          language: 'auto',
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.language, 'Gujarati');
      assert.equal(body.isLatinScript, false);
      assert.match(body.lyricsNative, /\[Verse\]/);
      assert.match(body.lyricsRoman, /aa saanj/);
      assert.ok(
        body.prompt.length > 20,
        'expands the vibe into a production prompt',
      );
      assert.equal(seen.token, 'sk-test');
      assert.equal(seen.idea, 'Aloopuri Khavsa');
      assert.equal(seen.language, 'auto');
    },
    {
      writeLyrics: async (args) => {
        seen = args;
        return SHEET;
      },
    },
  );
});

test('rejects a lyric request with no idea without calling the lyricist', async () => {
  let called = false;
  await withServer(
    global.fetch,
    async (base) => {
      const response = await fetch(`${base}/api/write-lyrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'sk-test', idea: '   ' }),
      });
      assert.equal(response.status, 400);
      assert.equal(
        (await response.json()).error,
        'Tell me what the song is about.',
      );
      assert.equal(called, false);
    },
    {
      writeLyrics: async () => {
        called = true;
        return SHEET;
      },
    },
  );
});

test('rejects a lyric request with no token', async () => {
  await withServer(
    global.fetch,
    async (base) => {
      const response = await fetch(`${base}/api/write-lyrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idea: 'Aloopuri Khavsa' }),
      });
      assert.equal(response.status, 400);
      assert.equal(
        (await response.json()).error,
        'Add your MiniMax API token.',
      );
    },
    { writeLyrics: async () => SHEET },
  );
});

test('rejects a malformed lyric token without calling the lyricist', async () => {
  let called = false;
  await withServer(
    global.fetch,
    async (base) => {
      const response = await fetch(`${base}/api/write-lyrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: 'not-a-minimax-token',
          idea: 'Aloopuri Khavsa',
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(
        (await response.json()).error,
        'MiniMax tokens start with sk-.',
      );
      assert.equal(called, false);
    },
    {
      writeLyrics: async () => {
        called = true;
        return SHEET;
      },
    },
  );
});

test('surfaces a lyricist failure as a readable message', async () => {
  await withServer(
    global.fetch,
    async (base) => {
      const response = await fetch(`${base}/api/write-lyrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'sk-test', idea: 'Aloopuri Khavsa' }),
      });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /could not read/i);
    },
    {
      writeLyrics: async () => {
        throw Object.assign(
          new Error(
            'The lyricist replied in a format I could not read. Try again.',
          ),
          { status: 502 },
        );
      },
    },
  );
});

test('rejects lyrics longer than the MiniMax ceiling', async () => {
  let contacted = false;
  await withServer(
    async () => {
      contacted = true;
    },
    async (base) => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'sk-test', lyrics: 'x'.repeat(3501) }),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /3,500 characters/);
      assert.equal(contacted, false);
    },
  );
});
