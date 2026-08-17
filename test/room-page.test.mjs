import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { roomPage } from '../share/room-page.mjs';
import { COURTYARD_SCENE } from '../share/courtyard.mjs';

test('room page escapes data and reuses the exact courtyard', () => {
  const html = roomPage('ABCD<script>', 'nonce-value');
  assert.doesNotMatch(html, /<script>ABCD/);
  assert.match(html, /ABCD&lt;script&gt;/);
  assert.match(html, /nonce="nonce-value"/);
  assert.ok(html.includes(COURTYARD_SCENE));
});

test('room page keeps a disabled player visible and makes synced lyrics prominent', () => {
  const html = roomPage('ABCDEFGH', 'n');
  for (const text of [
    'Join the mehfil', 'id="join-label">Join the mehfil', 'id="request"',
    'Reveal lyrics', 'id="audio"', 'id="lyric-stage"', 'id="lyric-primary"',
    'id="lyric-secondary"', 'id="listener-seek"', 'id="listener-play"', 'id="playback-state"',
    'Enable sound', 'Setlist', 'aria-live="polite"'
  ]) assert.ok(html.includes(text), text);
  assert.match(html, /id="listener-play"[^>]*disabled/);
  assert.match(html, /id="listener-seek"[^>]*disabled/);
  assert.doesNotMatch(html, /id="player"[^>]*hidden/);
  assert.match(html, /\.lyric-primary \{[^}]*clamp\(27px,3\.3vw,44px\)/);
});

test('joined room distills requests and activity behind one compact disclosure', () => {
  const html = roomPage('ABCDEFGH', 'n');
  assert.match(html, /<details id="room-menu" class="room-menu">/);
  assert.match(html, /room-menu-label">Request a song/);
  assert.match(html, /<form id="request" class="request-form">/);
  assert.match(html, /<details class="activity">[\s\S]*Request queue[\s\S]*Setlist/);
  assert.doesNotMatch(html, /class="composer request-composer"/);
  assert.match(html, /body:has\(#room:not\(\[hidden\]\)\) \.room-layout/);
});

test('listener requests use the homepage language choices', () => {
  const html = roomPage('ABCDEFGH', 'n');
  assert.match(html, /<select id="language">[\s\S]*<option value="auto" selected>Auto-detect<\/option>/);
  for (const language of [
    'Gujarati', 'Hindi', 'Punjabi', 'Tamil', 'Bengali', 'Marathi', 'Urdu',
    'English', 'Spanish', 'French', 'Arabic', 'Japanese', 'Korean'
  ]) assert.match(html, new RegExp(`<option value="${language}">${language}</option>`));
});

test('room client carries the Worker bundler name helper into the browser', () => {
  assert.match(roomPage('ABCDEFGH', 'n'), /const __name = value => value;/);
});

test('room client uses same-origin paths, shared playback state, and session credentials', () => {
  const html = roomPage('ABCDEFGH', 'n');
  assert.match(html, /sessionStorage/);
  assert.doesNotMatch(html, /localStorage/);
  assert.match(html, /\/rooms\/\$\{roomId\}\/ws/);
  assert.match(html, /\/s\/\$\{song\.shareId\}\/audio/);
  assert.match(html, /playback\.changedAt/);
  assert.match(html, /roomPlaybackPositionMs/);
});

test('room client reconnects and keeps autoplay rejection recoverable', () => {
  const html = roomPage('ABCDEFGH', 'n');
  assert.match(html, /Math\.min\(1_000 \* 2 \*\* retryCount, 30_000\)/);
  assert.match(html, /Your browser blocked shared audio/);
  assert.match(html, /await audio\.play\(\)/);
});

test('room page contains no token or upload credential fields', () => {
  const html = roomPage('ABCDEFGH', 'n');
  assert.doesNotMatch(html, /MiniMax.*token|MEHFIL_SHARE_SECRET|uploadSecret|localStorage/);
});

test('listener follows host playback and sees synchronized native and romanized lyrics', async () => {
  const html = roomPage('ABCDEFGH', 'n');
  const scripts = [...html.matchAll(/<script(?: nonce="n")?>([\s\S]*?)<\/script>/g)];
  const source = scripts.at(-1)[1];

  class Element {
    constructor() {
      this.hidden = false;
      this.textContent = '';
      this.children = [];
      this.listeners = {};
      this.classNames = new Set();
      this.classList = {
        add: value => this.classNames.add(value),
        remove: value => this.classNames.delete(value)
      };
      this.options = [];
      this.duration = 100;
      this.currentTime = 0;
      this.readyState = 1;
      this.paused = true;
      this.attrs = {};
    }

    addEventListener(type, fn, options) {
      (this.listeners[type] ||= []).push({ fn, once: Boolean(options?.once) });
    }

    async emit(type, event = {}) {
      for (const item of [...(this.listeners[type] || [])]) {
        await item.fn(event);
        if (item.once) this.listeners[type] = this.listeners[type].filter(value => value !== item);
      }
    }

    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] || null; }
    reset() {}
  }

  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element('room-data').textContent = JSON.stringify({ roomId: 'ABCDEFGH' });
  element('name').value = 'Ada';
  element('enable-audio').hidden = true;
  element('lyric-stage').hidden = true;

  const audio = element('audio');
  let playCalls = 0;
  let loadCalls = 0;
  let rejectPlayback = false;
  const playedSources = [];
  audio.play = async () => {
    playCalls += 1;
    playedSources.push(audio.src);
    if (rejectPlayback) throw new Error('blocked');
    audio.paused = false;
  };
  audio.pause = () => { audio.paused = true; };
  audio.load = () => { loadCalls += 1; };

  const scene = element('scene');
  const document = {
    querySelector(selector) {
      return selector === '.scene' ? scene : element(selector.replace(/^#/, ''));
    },
    createElement() { return new Element(); }
  };
  const store = new Map();
  const sessionStorage = {
    getItem: key => store.get(key) || null,
    setItem: (key, value) => store.set(key, value),
    removeItem: key => store.delete(key)
  };
  class WebSocket {
    static OPEN = 1;
    static instances = [];
    constructor() {
      this.listeners = {};
      this.readyState = 1;
      WebSocket.instances.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    send() {}
    close() {}
    async emit(type, event = {}) {
      for (const fn of this.listeners[type] || []) await fn(event);
    }
  }

  const unlockBlobs = [];
  const testUrl = {
    createObjectURL: blob => {
      unlockBlobs.push(blob);
      return 'blob:test-unlock';
    },
    revokeObjectURL() {}
  };
  const context = {
    document, sessionStorage, WebSocket,
    location: { origin: 'https://share.example' },
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame: fn => fn(),
    Date, JSON, Math, URL: testUrl, Blob, Uint8Array, console
  };
  vm.runInNewContext(source, context);

  await element('join-panel').emit('submit', { preventDefault() {} });
  assert.equal(playCalls, 1, 'join tap attempts silent audio unlock');
  assert.match(playedSources[0], /^blob:/);
  assert.equal(unlockBlobs[0].type, 'audio/wav');
  assert.equal(unlockBlobs[0].size, 2044);

  const socket = WebSocket.instances[0];
  await socket.emit('open');
  const snapshot = (shareId, playback) => ({
    hostPresent: true,
    listenerCount: 1,
    participants: [{ name: 'Ada' }],
    queue: [],
    currentRecording: null,
    currentSong: {
      shareId, title: 'Rain', language: 'Hindi', startedAt: Date.now(), playback,
      lyrics: {
        language: 'Hindi', isLatinScript: false,
        lyricsNative: 'पहली\nदूसरी', lyricsRoman: 'pehli\ndusri'
      }
    },
    setlist: [],
    expiredAt: null
  });

  await socket.emit('message', { data: JSON.stringify({
    type: 'snapshot',
    state: snapshot('aaaaaaaaaaaaaaaa', {
      status: 'paused', positionMs: 12_000, changedAt: Date.now()
    })
  }) });
  assert.equal(audio.src, '/s/aaaaaaaaaaaaaaaa/audio');
  assert.equal(loadCalls, 2);
  assert.equal(playCalls, 1, 'a paused room never autoplays for the listener');
  assert.equal(audio.currentTime, 12);
  assert.equal(element('playback-state').textContent, 'Host paused');
  assert.equal(element('lyric-stage').hidden, false);
  assert.equal(element('lyric-primary').textContent, 'पहली');
  assert.equal(element('lyric-secondary').textContent, 'pehli');
  assert.ok(element('.identity').classNames.has('has-song'));

  await socket.emit('message', { data: JSON.stringify({
    type: 'snapshot',
    state: snapshot('aaaaaaaaaaaaaaaa', {
      status: 'playing', positionMs: 60_000, changedAt: Date.now() - 1_000
    })
  }) });
  await Promise.resolve();
  assert.equal(playCalls, 2, 'the host play event starts listener audio');
  assert.ok(audio.currentTime >= 60);
  await audio.emit('play');
  await audio.emit('timeupdate');
  assert.equal(element('playback-state').textContent, 'Playing with the host');
  assert.ok(element('player').classNames.has('is-playing'));
  assert.equal(element('lyric-primary').textContent, 'दूसरी');
  assert.equal(element('lyric-secondary').textContent, 'dusri');
  assert.ok(Number(element('listener-seek').value) >= 60);

  rejectPlayback = true;
  await socket.emit('message', { data: JSON.stringify({
    type: 'snapshot',
    state: snapshot('bbbbbbbbbbbbbbbb', {
      status: 'playing', positionMs: 0, changedAt: Date.now() - 500
    })
  }) });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(loadCalls, 3);
  assert.equal(playCalls, 3);
  assert.equal(element('enable-audio').hidden, false);
  assert.match(element('play-error').textContent, /Enable sound once/);

  await socket.emit('message', { data: JSON.stringify({
    type: 'snapshot',
    state: {
      ...snapshot('bbbbbbbbbbbbbbbb', {
        status: 'paused', positionMs: 0, changedAt: Date.now()
      }),
      currentSong: {
        ...snapshot('bbbbbbbbbbbbbbbb', {}).currentSong,
        title: 'Sun',
        language: 'English',
        lyrics: {
          language: 'English', isLatinScript: true,
          lyricsNative: 'New light\nNew words', lyricsRoman: 'New light\nNew words'
        },
        playback: { status: 'paused', positionMs: 0, changedAt: Date.now() }
      }
    }
  }) });
  assert.equal(element('song-title').textContent, 'Sun');
  assert.equal(element('lyric-title').textContent, 'Sun');
  assert.equal(element('lyric-primary').textContent, 'New light');
});

test('terminal room failures clear unusable credentials and suppress reconnect', () => {
  const html = roomPage('ABCDEFGH', 'n');
  assert.match(html, /code === 'resume-invalid'[\s\S]*stopRoom/);
  assert.match(html, /event\.code === 4002[\s\S]*stopRoom/);
  assert.match(html, /event\.code === 4004[\s\S]*stopRoom/);
  assert.match(html, /sessionStorage\.removeItem\(credentialKey\)/);
  assert.match(html, /if \(terminal\) return/);
});
