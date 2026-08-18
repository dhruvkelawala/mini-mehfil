// @ts-nocheck -- This compatibility suite preserves heterogeneous Worker and R2 fixture shapes from the pre-migration contract.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'vitest';
import {
  FOLK_MODERN_BACKGROUND_PATH,
  FOLK_MODERN_SCENE,
} from '../../src/worker/courtyard.ts';
import { playbackPage } from '../../src/worker/playback-page.ts';
import {
  activeTimelineEntry,
  buildSectionTimeline,
  parseLyricSheet,
} from '../../src/lyrics/lyric-sync.ts';
import {
  activePacedLine,
  buildLinePacing,
} from '../../src/lyrics/line-pacing.ts';
import {
  createR2Storage,
  createShareHandler,
} from '../../src/worker/sharing.ts';
import {
  createDurableRoomDirectory,
  createRoomRouter,
} from '../../src/worker/rooms.ts';

const ID = 'AbCdEfGhIjKlMnOp';
const SECRET = 'worker-upload-secret';
const IDEMPOTENCY_KEY = 'AbCdEfGhIjKlMnOpQrStUvWx';
const SONG = {
  title: 'Aloopuri Khavsa',
  language: 'Gujarati',
  nativeScriptName: 'Gujarati',
  isLatinScript: false,
  lyricsNative: '[Verse]\nઆ સાંજ ધીમે',
  lyricsRoman: '[Verse]\naa saanj dhime',
};

function memoryStorage() {
  const shares = new Map();
  const jobs = new Map();
  let revision = 0;
  return {
    async put(id, value) {
      shares.set(id, value);
    },
    async getMetadata(id) {
      return shares.get(id)?.metadata || null;
    },
    async getAudio(id) {
      const share = shares.get(id);
      if (!share) return null;
      return {
        body: share.audio,
        size: share.audio.byteLength,
        contentType: share.contentType,
      };
    },
    async claimJob(id, record) {
      if (jobs.has(id)) return { created: false, ...jobs.get(id) };
      const entry = { record, etag: `memory-${++revision}` };
      jobs.set(id, entry);
      return { created: true, ...entry };
    },
    async getJob(id) {
      return jobs.get(id) || null;
    },
    async transitionJob(id, record, etag) {
      const current = jobs.get(id);
      if (!current || current.etag !== etag) return { conflict: true };
      const entry = { record, etag: `memory-${++revision}` };
      jobs.set(id, entry);
      return { conflict: false, ...entry };
    },
  };
}

function jobRequest(path, { method = 'GET', body, authorized = true } = {}) {
  const headers = authorized ? { authorization: `Bearer ${SECRET}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init = { method, headers };
  if (body !== undefined && method !== 'GET') init.body = JSON.stringify(body);
  return new Request(`https://share.example${path}`, init);
}

function uploadFormRequest(form, headers = {}) {
  const requestHeaders = new Headers({
    authorization: `Bearer ${SECRET}`,
    'idempotency-key': IDEMPOTENCY_KEY,
  });
  for (const [name, value] of Object.entries(headers))
    requestHeaders.set(name, value);
  return new Request('https://share.example/shares', {
    method: 'POST',
    body: form,
    headers: requestHeaders,
  });
}

function uploadRequest(
  audio = new Uint8Array([73, 68, 51]),
  metadata = SONG,
  headers = {},
) {
  const form = new FormData();
  form.set('audio', new Blob([audio], { type: 'audio/mpeg' }), 'song.mp3');
  form.set('metadata', JSON.stringify(metadata));
  return uploadFormRequest(form, headers);
}

test('shared playback uses the folk-modern background from the app', () => {
  const html = playbackPage(
    ID,
    SONG,
    'nonce',
    'https://share.example',
    'https://share.example/preview.png',
  );
  assert.equal(html.includes(FOLK_MODERN_SCENE), true);
  assert.match(html, /rel="preload" as="image"/);
  assert.equal(html.includes(FOLK_MODERN_BACKGROUND_PATH), true);
  assert.doesNotMatch(html, /viewBox="0 0 1600 1000"/);
});

test('shared playback safely embeds titles containing slashes and newlines', () => {
  const html = playbackPage(
    ID,
    { ...SONG, title: 'Rain \\ refrain\nsecond line' },
    'nonce',
    'https://share.example',
    '',
  );
  const inlineScript = html.match(
    /<script nonce="nonce">([\s\S]*)<\/script>/,
  )?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new vm.Script(inlineScript));
  assert.equal(html.includes("'Play Rain \\ refrain\nsecond line'"), false);
});

class Element {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.classList = { toggle() {} };
    this.attributes = new Map();
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.value = 0;
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  append(child) {
    this.children.push(child);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  querySelector() {
    return new Element();
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  async emit(type) {
    return this.listeners.get(type)?.();
  }
  get text() {
    return (
      this.textContent || this.children.map((child) => child.text).join(' ')
    );
  }
}

/**
 * Renders a real shared playback page and runs its inline script against a
 * minimal DOM, so these assertions exercise the page as shipped rather than a
 * paraphrase of it.
 */
async function playbackHarness(metadata, mediaDuration) {
  const elements = new Map([
    ['#audio', new Element()],
    ['#play', new Element()],
    ['#seek', new Element()],
    ['#timecode', new Element()],
    ['#reveal-lines', new Element()],
    ['.performance-timing', new Element()],
    ['#replay', new Element()],
    ['#player-shell', new Element()],
    ['.scene', new Element()],
    ['#share', new Element()],
    ['#clock', new Element()],
  ]);
  const audio = elements.get('#audio');
  audio.currentTime = 0;
  audio.duration = mediaDuration;
  audio.paused = true;
  audio.ended = false;
  audio.play = async () => {
    audio.paused = false;
    await audio.emit('play');
  };
  audio.pause = async () => {
    audio.paused = true;
    await audio.emit('pause');
  };

  const html = await (
    await createShareHandler({
      storage: {
        ...memoryStorage(),
        async getMetadata() {
          return metadata;
        },
      },
      uploadSecret: SECRET,
    })(new Request(`https://share.example/s/${ID}`))
  ).text();
  const songData = /<script id="song-data"[^>]*>([\s\S]*?)<\/script>/.exec(
    html,
  )[1];
  const document = {
    querySelector(selector) {
      if (selector === '#song-data') return { textContent: songData };
      return elements.get(selector);
    },
    createElement() {
      return new Element();
    },
  };
  const frames = [];
  const script = [
    ...html.matchAll(/<script(?: nonce="[^"]+")?>([\s\S]*?)<\/script>/g),
  ].at(-1)[1];
  vm.runInNewContext(script, {
    document,
    navigator: { clipboard: { async writeText() {} } },
    location: { href: `https://share.example/s/${ID}` },
    Intl,
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame() {},
  });
  return {
    html,
    audio,
    elements,
    frames,
    songData: JSON.parse(songData),
    lines: () => elements.get('#reveal-lines').children,
    timingNote: () => elements.get('.performance-timing').textContent,
    async seekTo(seconds) {
      audio.currentTime = seconds;
      await audio.emit('timeupdate');
    },
  };
}

test('shared playback advances progress and lyrics without relying on timeupdate', async () => {
  const page = await playbackHarness(SONG, 100);
  await page.elements.get('#play').emit('click');
  page.audio.currentTime = 50;
  assert.equal(
    page.frames.length,
    1,
    'playing schedules a visual refresh independent of media events',
  );
  page.frames.shift()(16);
  assert.equal(Number(page.elements.get('#seek').value), 50);
  assert.ok(page.lines().some((line) => !line.hidden));
});

const TIMED_LYRICS = {
  ...SONG,
  isLatinScript: true,
  lyricsNative:
    '[Intro]\nOoh\n[Verse]\nRain on the window\nUnder amber light\n[Inst]\n—\n[Chorus]\nSing it back',
  lyricsRoman:
    '[Intro]\nOoh\n[Verse]\nRain on the window\nUnder amber light\n[Inst]\n—\n[Chorus]\nSing it back',
  lyricTiming: {
    version: 1,
    mode: 'minimax-section-asr',
    durationSeconds: 90,
    segments: [
      { start: 0, end: 12, label: 'intro' },
      { start: 12, end: 40, label: 'verse' },
      { start: 40, end: 52, label: 'silence' },
      { start: 52, end: 90, label: 'chorus' },
    ],
  },
};

test('a timed share follows its sections and never shows stale sung lines', async () => {
  const page = await playbackHarness(TIMED_LYRICS, 90);
  const sheet = parseLyricSheet(TIMED_LYRICS);
  const sharedTimeline = buildSectionTimeline(
    sheet.sections,
    TIMED_LYRICS.lyricTiming,
  );
  const sharedPacing = buildLinePacing(sheet.sections, sharedTimeline);
  assert.equal(page.songData.timeline.length, 4);
  assert.equal(page.songData.pacing.length, 4);
  assert.deepEqual(page.songData.timeline, sharedTimeline);
  assert.deepEqual(page.songData.pacing, sharedPacing);
  assert.equal(page.songData.expectedDurationSeconds, 90);
  assert.deepEqual(Object.keys(page.songData).sort(), [
    'expectedDurationSeconds',
    'lines',
    'pacing',
    'sections',
    'timeline',
  ]);

  // Before loadedmetadata the page is honest about being approximate.
  assert.match(page.html, /Atmospheric reveal · not synchronized/);
  await page.audio.emit('loadedmetadata');
  assert.equal(
    page.timingNote(),
    'Lines follow MiniMax sections · timing is approximate',
  );

  for (const seconds of [1, 20, 39, 45, 60, 5, 95]) {
    const timelineEntry = activeTimelineEntry(sharedTimeline, seconds);
    const pacedLine = activePacedLine(sharedPacing, seconds);
    assert.equal(
      page.songData.timeline.find(
        (entry) => entry.start <= seconds && seconds < entry.end,
      )?.sectionIndex ?? null,
      timelineEntry?.sectionIndex ?? null,
    );
    assert.equal(
      page.songData.pacing.find(
        (entry) => entry.start <= seconds && seconds < entry.end,
      )?.lineIndexInSection ?? null,
      pacedLine?.lineIndexInSection ?? null,
    );
  }

  await page.seekTo(1);
  assert.equal(page.lines().length, 1);
  assert.equal(
    page.lines()[0].className,
    'lyric-section lyric-section-current lyric-focus',
  );
  assert.match(page.lines()[0].text, /Intro/);
  assert.match(page.lines()[0].text, /Ooh/);
  assert.equal(
    page.lines()[0].children[1].className,
    'lyric-line lyric-line-current',
  );
  assert.equal(
    page.lines()[0].children[1].attributes.get('aria-current'),
    'true',
  );
  assert.match(page.lines()[0].text, /Rain on the window/);

  await page.seekTo(20);
  assert.match(page.lines()[0].text, /Rain on the window/);
  assert.match(page.lines()[0].text, /Ooh/);
  const renderedVerse = page.lines()[0];
  assert.equal(
    renderedVerse.children[2].className,
    'lyric-line lyric-line-current',
  );
  assert.equal(
    renderedVerse.children[3].className,
    'lyric-line lyric-context lyric-context-next',
  );
  await page.seekTo(39);
  assert.notEqual(page.lines()[0], renderedVerse);
  assert.equal(
    page.lines()[0].children[2].className,
    'lyric-line lyric-line-current',
  );

  // An unmapped silence shows a rest, not the verse that just ended.
  await page.seekTo(45);
  assert.equal(page.lines().length, 1);
  assert.equal(page.lines()[0].className, 'lyric-line lyric-cue');
  assert.equal(page.lines()[0].textContent, 'Pause');

  await page.seekTo(60);
  assert.match(page.lines()[0].text, /Sing it back/);

  // A backward seek is a fresh lookup, and the final lyric holds at song end.
  await page.seekTo(5);
  assert.match(page.lines()[0].text, /Ooh/);
  await page.seekTo(95);
  assert.equal(page.lines().length, 1);
  assert.match(page.lines()[0].text, /Sing it back/);
  assert.ok(
    page
      .lines()[0]
      .children.some(
        (child) => child.attributes.get('aria-current') === 'true',
      ),
  );
});

test('a timed share falls back to the approximate reveal when the audio does not match', async () => {
  const page = await playbackHarness(TIMED_LYRICS, 140);
  await page.audio.emit('loadedmetadata');
  assert.equal(page.timingNote(), 'Atmospheric reveal · not synchronized');
  // Re-validating the same mismatch keeps the approximate reveal.
  await page.audio.emit('loadedmetadata');
  assert.equal(page.timingNote(), 'Atmospheric reveal · not synchronized');
  await page.seekTo(139);
  assert.equal(page.lines().length, page.songData.sections.length);
  assert.ok(page.lines().every((line) => !line.hidden));

  page.audio.duration = 90;
  await page.audio.emit('loadedmetadata');
  assert.equal(
    page.timingNote(),
    'Lines follow MiniMax sections · timing is approximate',
  );
  await page.seekTo(20);
  assert.match(page.lines()[0].text, /Rain on the window/);
});

test('an untimed share serializes no timeline and reveals approximately', async () => {
  const page = await playbackHarness(SONG, 100);
  assert.equal(page.songData.timeline, null);
  assert.equal('pacing' in page.songData, false);
  assert.equal(page.songData.sections.length, 1);
  assert.equal(page.songData.expectedDurationSeconds, 0);
  await page.audio.emit('loadedmetadata');
  assert.equal(page.timingNote(), 'Atmospheric reveal · not synchronized');
  await page.seekTo(99);
  assert.equal(page.lines().length, 1);
  assert.equal(page.lines()[0].className, 'lyric-section');
  assert.match(page.lines()[0].text, /Verse/);
  assert.match(page.lines()[0].text, /આ સાંજ ધીમે/);
});

test('upload to playback round trip preserves title, language, and both lyric scripts', async () => {
  const handle = createShareHandler({
    storage: memoryStorage(),
    idGenerator: () => ID,
    uploadSecret: SECRET,
    publicBaseUrl: 'https://minimehfil.wtf',
    previewImageUrl: 'https://share.example/preview.png',
  });
  const upload = await handle(uploadRequest());
  assert.equal(upload.status, 201);
  assert.deepEqual(await upload.json(), {
    id: ID,
    url: `https://share.example/s/${ID}`,
  });

  const page = await handle(new Request(`https://share.example/s/${ID}`));
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get('content-security-policy'),
    /default-src 'none'/,
  );
  assert.match(
    page.headers.get('content-security-policy'),
    /img-src 'self' data:/,
  );
  assert.match(html, /Aloopuri Khavsa/);
  assert.match(html, /Gujarati · Gujarati/);
  assert.match(html, /આ સાંજ ધીમે/);
  assert.match(html, /aa saanj dhime/);
  assert.match(html, /Make your own song/);
  assert.match(html, /class="scene"/);
  assert.match(html, /backgrounds\/04-folk-modern-dusk\.png/);
  assert.doesNotMatch(html, /viewBox="0 0 1600 1000"/);
  assert.match(html, /class="performance"/);
  assert.match(html, /class="player-shell"/);
  assert.match(html, /class="record-label">M</);
  assert.match(html, /id="seek"/);
  assert.match(html, /id="timecode"/);
  assert.match(html, /id="replay"/);
  assert.match(html, /class="topbar-link-icon"/);
  assert.match(html, /class="player-icon play-icon"/);
  assert.match(html, /class="player-icon pause-icon"/);
  assert.match(html, /id="share"[^>]*>[\s\S]*?<svg class="player-icon"/);
  assert.match(html, /class="player-icon download-icon"/);
  assert.doesNotMatch(html, new RegExp(`Make your own song \\u${'2197'}`, 'u'));
  assert.doesNotMatch(html, new RegExp(`id="share"[^>]*>\\u${'2197'}`, 'u'));
  assert.doesNotMatch(html, /share\.innerHTML/);
  assert.doesNotMatch(html, /<audio[^>]+controls/);
  assert.doesNotMatch(html, /class="courtyard"/);
  assert.match(
    html,
    /property="og:url" content="https:\/\/minimehfil\.wtf\/s\/AbCdEfGhIjKlMnOp"/,
  );
  assert.match(
    html,
    /property="og:audio" content="https:\/\/minimehfil\.wtf\/s\/AbCdEfGhIjKlMnOp\/audio"/,
  );
  assert.match(html, /href="https:\/\/minimehfil\.wtf">Make your own song/);
  assert.match(html, /property="og:audio:type" content="audio\/mpeg"/);
  assert.match(html, /name="twitter:card" content="player"/);
  assert.match(
    html,
    /name="twitter:image" content="https:\/\/share\.example\/preview\.png"/,
  );

  const audio = await handle(
    new Request(`https://share.example/s/${ID}/audio`),
  );
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.equal(audio.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(
    new Uint8Array(await audio.arrayBuffer()),
    new Uint8Array([73, 68, 51]),
  );
});

const TIMED_SONG = {
  ...SONG,
  lyricTiming: {
    version: 1,
    mode: 'minimax-section-asr',
    durationSeconds: 90,
    segments: [
      { start: 0, end: 12, label: 'intro' },
      { start: 12, end: 90, label: 'verse' },
    ],
  },
};

test('stores and re-serves only the normalized timing artifact', async () => {
  const storage = memoryStorage();
  const handle = createShareHandler({
    storage,
    idGenerator: () => ID,
    uploadSecret: SECRET,
  });
  const upload = await handle(
    uploadRequest(new Uint8Array([73, 68, 51]), {
      ...TIMED_SONG,
      lyricTiming: {
        ...TIMED_SONG.lyricTiming,
        traceId: 'trace-5678',
        coverFeatureId: 'feature-1234',
        segments: TIMED_SONG.lyricTiming.segments.map((segment) => ({
          ...segment,
          confidence: 0.91,
          text: 'raw ASR transcript that must never be stored',
        })),
      },
      formattedLyrics: 'raw ASR transcript that must never be stored',
    }),
  );
  assert.equal(upload.status, 201);

  const stored = await storage.getMetadata(ID);
  assert.deepEqual(stored.lyricTiming, TIMED_SONG.lyricTiming);
  const serialized = JSON.stringify(stored);
  assert.doesNotMatch(serialized, /raw ASR transcript/);
  assert.doesNotMatch(serialized, /trace-5678|feature-1234|confidence/);
  assert.equal(stored.formattedLyrics, undefined);

  const html = await (
    await handle(new Request(`https://share.example/s/${ID}`))
  ).text();
  assert.doesNotMatch(html, /raw ASR transcript|trace-5678|feature-1234/);
});

test('rejects malformed timing as firmly as any other malformed detail', async () => {
  const malformed = {
    'a non-object': 'timed',
    'an unknown mode': { ...TIMED_SONG.lyricTiming, mode: 'guesswork' },
    'a future version': { ...TIMED_SONG.lyricTiming, version: 2 },
    'an unknown label': {
      ...TIMED_SONG.lyricTiming,
      segments: [{ start: 0, end: 12, label: 'karaoke' }],
    },
    'overlapping segments': {
      ...TIMED_SONG.lyricTiming,
      segments: [
        { start: 0, end: 12, label: 'intro' },
        { start: 11, end: 90, label: 'verse' },
      ],
    },
    'segments more than a second past the duration': {
      ...TIMED_SONG.lyricTiming,
      segments: [{ start: 0, end: 91.5, label: 'verse' }],
    },
  };
  for (const [name, lyricTiming] of Object.entries(malformed)) {
    const handle = createShareHandler({
      storage: memoryStorage(),
      idGenerator: () => ID,
      uploadSecret: SECRET,
    });
    const response = await handle(
      uploadRequest(new Uint8Array([73, 68, 51]), { ...SONG, lyricTiming }),
    );
    assert.equal(response.status, 400, name);
    assert.match((await response.json()).error, /Invalid song details/, name);
  }
});

test('accepts shares with absent or null timing exactly as before', async () => {
  for (const metadata of [SONG, { ...SONG, lyricTiming: null }]) {
    const storage = memoryStorage();
    const handle = createShareHandler({
      storage,
      idGenerator: () => ID,
      uploadSecret: SECRET,
    });
    const response = await handle(
      uploadRequest(new Uint8Array([73, 68, 51]), metadata),
    );
    assert.equal(response.status, 201);
    assert.equal((await storage.getMetadata(ID)).lyricTiming, null);
  }
});

test('renders a share stored before section timing existed', async () => {
  const legacy = { ...SONG, createdAt: '2026-08-01T00:00:00.000Z' };
  const handle = createShareHandler({
    storage: {
      ...memoryStorage(),
      async getMetadata() {
        return legacy;
      },
    },
    uploadSecret: SECRET,
  });
  const page = await handle(new Request(`https://share.example/s/${ID}`));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /આ સાંજ ધીમે/);
  assert.match(html, /Atmospheric reveal · not synchronized/);
});

test('maximum lyrics plus a full timeline fit the metadata size limit', () => {
  const oversized = JSON.stringify({
    title: 'x'.repeat(120),
    language: 'x'.repeat(80),
    nativeScriptName: 'x'.repeat(80),
    isLatinScript: false,
    lyricsNative: 'ધ'.repeat(5000),
    lyricsRoman: 'x'.repeat(5000),
    lyricTiming: {
      version: 1,
      mode: 'minimax-section-asr',
      durationSeconds: 359.999,
      segments: Array.from({ length: 64 }, (_, index) => ({
        start: index * 5.625 + 0.125,
        end: (index + 1) * 5.625,
        label: 'chorus',
      })),
    },
  });
  // validateMetadata rejects anything over 16 KB of JSON.
  assert.ok(
    oversized.length <= 16 * 1024,
    `metadata JSON was ${oversized.length} characters`,
  );
});

test('rejects audio over 10 MB', async () => {
  const handle = createShareHandler({
    storage: memoryStorage(),
    idGenerator: () => ID,
    uploadSecret: SECRET,
  });
  const response = await handle(
    uploadRequest(new Uint8Array(10 * 1024 * 1024 + 1)),
  );
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /10 MB/);
});

test('rejects unsupported content types', async () => {
  const form = new FormData();
  form.set(
    'audio',
    new Blob(['not audio'], { type: 'text/plain' }),
    'notes.txt',
  );
  form.set('metadata', JSON.stringify(SONG));
  const handle = createShareHandler({
    storage: memoryStorage(),
    idGenerator: () => ID,
    uploadSecret: SECRET,
  });
  const response = await handle(uploadFormRequest(form));
  assert.equal(response.status, 415);
  assert.match((await response.json()).error, /Only MP3/);
});

test('rejects non-object metadata without leaking an internal error', async () => {
  const form = new FormData();
  form.set('audio', new Blob(['audio'], { type: 'audio/mpeg' }), 'song.mp3');
  form.set('metadata', 'null');
  const handle = createShareHandler({
    storage: memoryStorage(),
    idGenerator: () => ID,
    uploadSecret: SECRET,
  });
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
    rateLimit: async (key) => {
      seen = key;
      return false;
    },
  });
  const response = await handle(
    uploadRequest(undefined, SONG, { 'cf-connecting-ip': '203.0.113.8' }),
  );
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
    rateLimit: async () => {
      rateLimitCalled = true;
      return true;
    },
  });
  const form = new FormData();
  form.set('audio', new Blob(['audio'], { type: 'audio/mpeg' }), 'song.mp3');
  form.set('metadata', JSON.stringify(SONG));
  const response = await handle(
    new Request('https://share.example/shares', { method: 'POST', body: form }),
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  assert.equal(rateLimitCalled, false);
});

test('derives the same unguessable share URL from retry idempotency keys', async () => {
  const handle = createShareHandler({
    storage: memoryStorage(),
    uploadSecret: SECRET,
  });
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
  storage.put = async (id, value) => {
    stored = value;
    await originalPut(id, value);
  };
  const handle = createShareHandler({
    storage,
    idGenerator: () => ID,
    uploadSecret: SECRET,
  });
  const response = await handle(
    uploadRequest(undefined, {
      ...SONG,
      token: 'sk-cp-secret',
      apiKey: 'also-secret',
    }),
  );
  assert.equal(response.status, 201);
  assert.equal(stored.metadata.token, undefined);
  assert.equal(stored.metadata.apiKey, undefined);
  assert.doesNotMatch(JSON.stringify(stored.metadata), /secret/);
});

test('generation jobs are claimed once and duplicate claims return the original pending record', async () => {
  const storage = memoryStorage();
  const handle = createShareHandler({
    storage,
    uploadSecret: SECRET,
    now: () => Date.parse('2026-08-15T12:00:00Z'),
  });
  const first = await handle(
    jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, { method: 'POST' }),
  );
  const duplicate = await handle(
    jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, { method: 'POST' }),
  );
  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), await first.json());
  const record = (await storage.getJob(IDEMPOTENCY_KEY)).record;
  assert.equal(record.status, 'pending');
  assert.equal(record.createdAt, '2026-08-15T12:00:00.000Z');
  assert.equal(record.expiresAt, '2026-08-16T12:00:00.000Z');
});

test('an abandoned generation becomes a durable failure instead of staying pending forever', async () => {
  const storage = memoryStorage();
  let current = Date.parse('2026-08-15T12:00:00Z');
  const handle = createShareHandler({
    storage,
    uploadSecret: SECRET,
    now: () => current,
  });
  await handle(
    jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, { method: 'POST' }),
  );

  current += 5 * 60 * 1000 + 1;
  const status = await handle(
    jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`),
  );
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    version: 1,
    jobId: IDEMPOTENCY_KEY,
    status: 'failed',
    createdAt: '2026-08-15T12:00:00.000Z',
    updatedAt: '2026-08-15T12:05:00.001Z',
    expiresAt: '2026-08-16T12:00:00.000Z',
    error: {
      code: 'GENERATION_INTERRUPTED',
      message:
        'The recording stopped before it could finish. Try the mehfil again.',
    },
  });

  const duplicate = await handle(
    jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, { method: 'POST' }),
  );
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).status, 'failed');
  const lateCompletion = await handle(
    jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, {
      method: 'PUT',
      body: { status: 'complete', source: 'https://cdn.example/song.mp3' },
    }),
  );
  assert.equal(lateCompletion.status, 409);
});

test('generation job completion is whitelisted, conditional, and idempotent', async () => {
  const storage = memoryStorage();
  const handle = createShareHandler({
    storage,
    uploadSecret: SECRET,
    now: () => Date.parse('2026-08-15T12:00:00Z'),
  });
  await handle(
    jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, { method: 'POST' }),
  );
  const body = {
    status: 'complete',
    source: 'https://cdn.example/song.mp3?signature=private',
    traceId: 'trace-safe',
    token: 'secret',
    lyrics: 'private',
    prompt: 'private',
  };
  const completed = await handle(
    jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, { method: 'PUT', body }),
  );
  assert.equal(completed.status, 200);
  const value = await completed.json();
  assert.equal(value.createdAt, '2026-08-15T12:00:00.000Z');
  assert.equal(value.source, body.source);
  assert.equal(value.traceId, 'trace-safe');
  assert.equal(value.token, undefined);
  assert.equal(value.lyrics, undefined);
  assert.equal(value.prompt, undefined);
  assert.equal(
    (
      await handle(
        jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, {
          method: 'PUT',
          body,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await handle(
        jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, {
          method: 'PUT',
          body: {
            status: 'failed',
            error: { code: 'GENERATION_FAILED', message: 'No song.' },
          },
        }),
      )
    ).status,
    409,
  );
});

test('generation jobs reject non-HTTPS and malformed audio sources', async () => {
  for (const source of [
    'http://cdn.example/song.mp3',
    'not-a-url-or-hex',
    'abc',
  ]) {
    const handle = createShareHandler({
      storage: memoryStorage(),
      uploadSecret: SECRET,
    });
    await handle(
      jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, {
        method: 'POST',
      }),
    );
    const response = await handle(
      jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, {
        method: 'PUT',
        body: { status: 'complete', source },
      }),
    );
    assert.equal(response.status, 400);
  }
});

test('generation job routes reject invalid, expired, oversized, and unauthenticated requests without mutation', async () => {
  const storage = memoryStorage();
  let current = Date.parse('2026-08-15T12:00:00Z');
  const handle = createShareHandler({
    storage,
    uploadSecret: SECRET,
    now: () => current,
  });
  assert.equal(
    (
      await handle(
        jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, {
          method: 'POST',
          authorized: false,
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (await handle(jobRequest('/generation-jobs/bad/claim', { method: 'POST' })))
      .status,
    400,
  );
  await handle(
    jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}/claim`, { method: 'POST' }),
  );
  const malformed = await handle(
    new Request(`https://share.example/generation-jobs/${IDEMPOTENCY_KEY}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${SECRET}`,
        'content-type': 'application/json',
      },
      body: '{',
    }),
  );
  assert.equal(malformed.status, 400);
  assert.equal(
    (
      await handle(
        jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, {
          method: 'PUT',
          body: { status: 'complete', source: 'x'.repeat(70 * 1024) },
        }),
      )
    ).status,
    413,
  );
  current += 24 * 60 * 60 * 1000 + 1;
  assert.equal(
    (await handle(jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`))).status,
    404,
  );
  assert.equal(
    (
      await handle(
        jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, {
          method: 'PUT',
          body: {
            status: 'failed',
            error: { code: 'FAILED', message: 'Failed.' },
          },
        }),
      )
    ).status,
    404,
  );
});

test('R2 generation storage uses atomic create and handles conditional conflicts', async () => {
  const puts = [];
  let getResult = null;
  const bucket = {
    async put(key, value, options) {
      puts.push({ key, value: JSON.parse(value), options });
      return null;
    },
    async get() {
      return getResult;
    },
  };
  const storage = createR2Storage(bucket);
  const record = { version: 1, jobId: IDEMPOTENCY_KEY, status: 'pending' };
  const claim = await storage.claimJob(IDEMPOTENCY_KEY, record);
  assert.equal(claim.created, false);
  assert.deepEqual(puts[0].options.onlyIf, { etagDoesNotMatch: '*' });
  getResult = {
    httpEtag: '"etag-1"',
    async text() {
      return JSON.stringify(record);
    },
  };
  assert.deepEqual(await storage.getJob(IDEMPOTENCY_KEY), {
    record,
    etag: 'etag-1',
  });
  const transition = await storage.transitionJob(
    IDEMPOTENCY_KEY,
    { ...record, status: 'failed' },
    'etag-1',
  );
  assert.equal(transition.conflict, true);
  assert.deepEqual(puts[1].options.onlyIf, { etagMatches: 'etag-1' });
});

test('an identical terminal transition that loses an ETag race is idempotent success', async () => {
  const createdAt = '2026-08-15T12:00:00.000Z';
  const pending = {
    version: 1,
    jobId: IDEMPOTENCY_KEY,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    expiresAt: '2026-08-16T12:00:00.000Z',
  };
  const complete = {
    ...pending,
    status: 'complete',
    source: 'https://cdn.example/song.mp3',
  };
  let reads = 0;
  const storage = {
    async getJob() {
      reads += 1;
      return {
        record: reads === 1 ? pending : complete,
        etag: `etag-${reads}`,
      };
    },
    async transitionJob() {
      return { conflict: true };
    },
    async claimJob() {
      throw new Error('not used');
    },
  };
  const handle = createShareHandler({
    storage,
    uploadSecret: SECRET,
    now: () => Date.parse(createdAt),
  });
  const response = await handle(
    jobRequest(`/generation-jobs/${IDEMPOTENCY_KEY}`, {
      method: 'PUT',
      body: { status: 'complete', source: complete.source },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, complete.source);
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
        httpMetadata: { contentType: 'audio/mpeg' },
      };
    },
  };
  const handle = createShareHandler({ storage: createR2Storage(bucket) });

  const partial = await handle(
    new Request(`https://share.example/s/${ID}/audio`, {
      headers: { range: 'bytes=1-3' },
    }),
  );
  assert.equal(partial.status, 206);
  assert.deepEqual(requestedRange, { offset: 1, length: 3 });
  assert.equal(partial.headers.get('content-range'), 'bytes 1-3/5');
  assert.equal(partial.headers.get('content-length'), '3');
  assert.equal(partial.headers.get('etag'), '"r2-etag"');
  assert.equal(partial.headers.get('cache-control'), 'no-store');
  assert.deepEqual(
    new Uint8Array(await partial.arrayBuffer()),
    new Uint8Array([68, 51, 4]),
  );

  const head = await handle(
    new Request(`https://share.example/s/${ID}/audio`, { method: 'HEAD' }),
  );
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '5');
  assert.equal(
    head.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const unsatisfiable = await handle(
    new Request(`https://share.example/s/${ID}/audio`, {
      headers: { range: 'bytes=8-10' },
    }),
  );
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */5');
  assert.equal((await unsatisfiable.arrayBuffer()).byteLength, 0);
});

function roomWorker(overrides = {}) {
  const calls = [];
  const directory = {
    async initialize(id, data) {
      calls.push(['initialize', id, data]);
      return true;
    },
    async connect(id, request) {
      calls.push(['connect', id, request]);
      return new Response('upgrade', { status: 200 });
    },
  };
  const routeRoomRequest = createRoomRouter({
    directory,
    secret: SECRET,
    rateLimit: async () => true,
    createCode: () => 'ABCDEFGH',
    createHostSecret: () => 'a'.repeat(43),
    renderPage: async () => '<!doctype html><title>Live mehfil</title>',
    ...overrides,
  });
  const shareHandler = () => new Response('share', { status: 404 });
  const handle = async (request) =>
    (await routeRoomRequest(request)) || shareHandler(request);
  return { calls, handle };
}

test('room creation authenticates before rate limit and separates secrets from URLs', async () => {
  let limited = false;
  const { handle, calls } = roomWorker({
    rateLimit: async () => {
      limited = true;
      return true;
    },
  });
  const unauthorized = await handle(
    new Request('https://share.example/rooms', { method: 'POST' }),
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(limited, false);
  const response = await handle(
    new Request('https://share.example/rooms', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.roomId, 'ABCDEFGH');
  assert.equal(body.joinUrl, 'https://share.example/r/ABCDEFGH');
  assert.equal(body.socketUrl, 'wss://share.example/rooms/ABCDEFGH/ws');
  assert.doesNotMatch(
    body.joinUrl + body.socketUrl,
    /a{20}|worker-upload-secret|sk-cp-/,
  );
  assert.equal(calls[0][0], 'initialize');
});
test('room join page applies strict headers and supports HEAD', async () => {
  const { handle } = roomWorker();
  for (const method of ['GET', 'HEAD']) {
    const response = await handle(
      new Request('https://share.example/r/ABCDEFGH', { method }),
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-security-policy'),
      /default-src 'none'/,
    );
    assert.match(
      response.headers.get('content-security-policy'),
      /media-src 'self' blob:/,
    );
    assert.match(
      response.headers.get('content-security-policy'),
      /img-src 'self' data:/,
    );
    assert.match(
      response.headers.get('content-security-policy'),
      /frame-ancestors 'none'/,
    );
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    if (method === 'HEAD') assert.equal(await response.text(), '');
  }
});
test('invalid room ids are not forwarded and valid upgrades are', async () => {
  const { handle, calls } = roomWorker();
  assert.equal(
    (await handle(new Request('https://share.example/r/IIIIIIII'))).status,
    404,
  );
  const response = await handle(
    new Request('https://share.example/rooms/ABCDEFGH/ws'),
  );
  assert.equal(response.status, 200);
  assert.equal(calls.at(-1)[0], 'connect');
});

test('Durable Object directory maps each room code to its named object', async () => {
  const calls = [];
  const room = {
    async fetch(request, options) {
      calls.push([request, options]);
      return new Response(null, { status: options ? 201 : 200 });
    },
  };
  const namespace = {
    idFromName(name) {
      calls.push(['idFromName', name]);
      return `id:${name}`;
    },
    get(id) {
      calls.push(['get', id]);
      return room;
    },
  };
  const directory = createDurableRoomDirectory(namespace);

  assert.equal(await directory.initialize('ABCDEFGH', { openedAt: 1 }), true);
  await directory.connect(
    'ABCDEFGH',
    new Request('https://share.example/rooms/ABCDEFGH/ws'),
  );

  assert.deepEqual(
    calls.filter((call) => call[0] === 'idFromName'),
    [
      ['idFromName', 'ABCDEFGH'],
      ['idFromName', 'ABCDEFGH'],
    ],
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === 'get'),
    [
      ['get', 'id:ABCDEFGH'],
      ['get', 'id:ABCDEFGH'],
    ],
  );
});
