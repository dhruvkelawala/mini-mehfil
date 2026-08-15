const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const recovery = fs.readFileSync(path.join(__dirname, '..', 'public', 'generation-recovery.js'), 'utf8');
const diagnostics = fs.readFileSync(path.join(__dirname, '..', 'public', 'media-diagnostics.js'), 'utf8');
const playbackPage = fs.readFileSync(path.join(__dirname, '..', 'share', 'playback-page.mjs'), 'utf8');

function functionBody(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const open = app.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < app.length; index += 1) {
    if (app[index] === '{') depth += 1;
    if (app[index] === '}') depth -= 1;
    if (depth === 0) return app.slice(open + 1, index);
  }
  assert.fail(`${name} should have a complete body`);
}

function browserHarness({ deferFirstLyrics = false } = {}) {
  class FakeElement {
    constructor(selector = '') {
      this.selector = selector;
      this.hidden = false;
      this.disabled = false;
      this.inert = false;
      this.paused = true;
      this.ended = false;
      this.duration = NaN;
      this.currentTime = 0;
      this.src = '';
      this.value = '';
      this.textContent = '';
      this.dataset = {};
      this.children = [];
      this.listeners = new Map();
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    append(...children) { this.children.push(...children); }
    after() {}
    focus() { document.activeElement = this; }
    getClientRects() { return [1]; }
    load() {}
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    querySelector(selector) { return new FakeElement(`${this.selector} ${selector}`); }
    querySelectorAll() { return []; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    replaceChildren(...children) { this.children = children; }
    reportValidity() { return true; }
    setAttribute() {}
  }

  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement(selector));
    return elements.get(selector);
  };
  const documentListeners = new Map();
  const windowListeners = new Map();
  const document = {
    activeElement: element('.generate'),
    body: element('body'),
    visibilityState: 'visible',
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    createDocumentFragment() { return new FakeElement('fragment'); },
    createElement(tag) { return new FakeElement(tag); },
    querySelector: element
  };
  element('#performance').hidden = true;
  element('#check-generation').hidden = true;

  const state = {
    pending: null,
    recoveryOptions: null,
    recoveryStarts: 0,
    writeLyricsPosts: 0,
    generatePosts: 0,
    diagnosticRetryLabel: null,
    rejectLyrics: null,
    resolveGenerate: null
  };
  const coordinator = {
    cancel() {},
    clear() { state.pending = null; },
    createJobId() { return 'AbCdEfGhIjKlMnOpQrStUvWx'; },
    current() { return state.current || null; },
    read() { return state.pending; },
    resume() { if (state.current) state.recoveryOptions.onPending({}, state.current); },
    save(value) { state.pending = value; return value; },
    start(pending) {
      state.current = pending;
      state.recoveryStarts += 1;
      state.recoveryOptions.onPending({}, pending);
      return true;
    }
  };
  const window = {
    MehfilGenerationRecovery: { create(options) { state.recoveryOptions = options; return coordinator; } },
    MehfilMediaDiagnostics: {
      attachMedia() {}, fatal() {}, record() {}, redactUrl() { return '[redacted]'; },
      setRetryAction(label) { state.diagnosticRetryLabel = label; },
      setRetryHandler() {}, snapshot() { return null; }
    },
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    confirm() { return true; }
  };
  class TestURL extends URL {}
  TestURL.createObjectURL = () => 'blob:test';
  TestURL.revokeObjectURL = () => {};
  const response = value => ({
    ok: true,
    status: 200,
    headers: { get() { return 'application/json'; } },
    async json() { return value; }
  });
  vm.runInNewContext(app, {
    Blob, console, document, fetch: async url => {
      if (url === '/api/write-lyrics') {
        state.writeLyricsPosts += 1;
        if (deferFirstLyrics && state.writeLyricsPosts === 1) {
          return new Promise((resolve, reject) => { state.rejectLyrics = reject; });
        }
        return response({
          title: 'Monsoon Song', language: 'Gujarati', languageCode: 'gu', nativeScriptName: 'Gujarati',
          isLatinScript: false, lyricsNative: 'વરસાદ', lyricsRoman: 'varsaad', prompt: 'Warm monsoon folk'
        });
      }
      if (url === '/api/generate') {
        state.generatePosts += 1;
        return new Promise(resolve => { state.resolveGenerate = value => resolve(response(value)); });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    Intl, performance: { now: () => 0 }, Promise, setInterval: () => 1,
    clearInterval() {}, setTimeout: () => 1, sessionStorage: {}, URL: TestURL,
    Uint8Array, window
  }, { filename: 'public/app.js' });

  return {
    element,
    state,
    background() { document.visibilityState = 'hidden'; documentListeners.get('visibilitychange')(); },
    foreground() { document.visibilityState = 'visible'; documentListeners.get('visibilitychange')(); },
    pageshow() { windowListeners.get('pageshow')(); },
    submit() { return element('#song-form').listeners.get('submit')({ preventDefault() {} }); }
  };
}

test('player controls use SVG icons instead of platform-dependent glyphs', () => {
  const start = html.indexOf('<section class="player-shell"');
  const player = html.slice(start, html.indexOf('</section>', start));
  assert.doesNotMatch(player, /[▶❚↗↓✓↻]/);
  assert.match(player, /id="play"[\s\S]*play-icon[\s\S]*pause-icon/);
  assert.match(player, /id="share"[\s\S]*<svg class="player-icon"/);
  assert.match(player, /id="download"[\s\S]*<svg class="player-icon"/);
  assert.doesNotMatch(app, /shareButton\.innerHTML|playButton\.querySelector\(['"]span['"]\)/);
});

test('loading messages keep looping and user-facing copy contains no em dashes', () => {
  const timers = [];
  const field = () => ({ disabled: false });
  const context = {
    generateButton: field(), tokenInput: field(), ideaInput: field(), vibeInput: field(), languageSelect: field(),
    notice: { className: '', textContent: '' }, waitingTimer: null,
    clearInterval() {},
    setInterval(callback) { timers.push(callback); return timers.length; },
    showPerformanceStatus() {}
  };
  const setBusy = vm.runInNewContext(`(function setBusy(busy, lines) {${functionBody('setBusy')}})`, context);
  const lines = ['one', 'two', 'three'];
  setBusy(true, lines);
  timers[0]();
  timers[0]();
  timers[0]();
  assert.equal(context.notice.textContent, 'one');

  for (const source of [app, html, diagnostics, playbackPage]) assert.doesNotMatch(source, /—/);
});

test('a stale share request cannot mutate a later generation', () => {
  assert.match(app, /let generationRun\s*=\s*0/);
  const clearLoadedSong = functionBody('clearLoadedSong');
  assert.match(clearLoadedSong, /generationRun\s*\+=\s*1/);

  const shareHandler = app.slice(app.indexOf("shareButton.addEventListener('click'"));
  assert.match(shareHandler, /const requestRun\s*=\s*generationRun/);
  assert.match(shareHandler, /const requestReference\s*=\s*shareReference/);
  assert.match(shareHandler, /requestRun\s*===\s*generationRun\s*&&\s*requestReference\s*===\s*shareReference/);
});

test('a new generation clears the previous recording before changing lyric state', () => {
  const clearLoadedSong = functionBody('clearLoadedSong');
  assert.match(clearLoadedSong, /audio\.removeAttribute\(['"]src['"]\)/);
  assert.match(clearLoadedSong, /audio\.load\(\)/);
  assert.match(clearLoadedSong, /playButton\.disabled\s*=\s*true/);
  assert.match(clearLoadedSong, /download\.setAttribute\(['"]aria-disabled['"],\s*['"]true['"]\)/);

  const submitStart = app.slice(app.indexOf("form.addEventListener('submit'"), app.indexOf('\n  try {', app.indexOf("form.addEventListener('submit'")));
  assert.ok(submitStart.indexOf('clearLoadedSong()') < submitStart.indexOf('resetPeek()'), 'old media is cleared before lyrics are reset');
});

test('all playback attempts surface the real rejection through diagnostics', () => {
  const attemptPlayback = functionBody('attemptPlayback');
  assert.match(attemptPlayback, /await audio\.play\(\)/);
  assert.match(attemptPlayback, /diagnostics\.fatal\(['"]audio\.play\(\) rejected['"],\s*error,\s*audio/);
  assert.doesNotMatch(app, /audio\.play\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(app, /attemptPlayback\(['"]generation-complete['"]\)/);
  assert.match(app, /attemptPlayback\(['"]replay-button['"]\)/);
  assert.match(app, /attemptPlayback\(['"]play-button['"]\)/);
});

test('the opt-in diagnostic panel loads before the application', () => {
  assert.match(html, /id="media-diagnostics"/);
  assert.match(html, /id="media-diagnostics-copy"/);
  assert.match(html, /id="media-diagnostics-download"/);
  assert.ok(html.indexOf('/media-diagnostics.js') < html.indexOf('/app.js'));
  assert.ok(html.indexOf('/generation-recovery.js') < html.indexOf('/app.js'));
});

test('generation recovery is wired without retrying the paid request', () => {
  assert.match(app, /sessionStorage/);
  assert.match(app, /jobId/);
  assert.match(app, /finalizeGeneration/);
  assert.match(recovery, /\/api\/generation-status/);
  assert.match(app, /pageshow/);
  assert.match(app, /visibilitychange/);
  assert.match(html, /id="check-generation"/);
  assert.match(app, /checkGenerationButton\.addEventListener\(['"]click['"]/);
  assert.match(app, /onRetryable[\s\S]*setBusy\(false, \[\]\)[\s\S]*checkGenerationButton\.hidden = false/);
  assert.match(app, /replace\(\/\^0x\/i, ['"]['"]\)/);
  const recoverySection = functionBody('resumePendingGeneration');
  assert.doesNotMatch(recoverySection, /post\(['"]\/api\/generate/);
  assert.match(recoverySection, /if \(generationRequestInFlight\) return false/);
  assert.match(app, /generationRequestInFlight = true[\s\S]*await post\(['"]\/api\/generate[\s\S]*finally[\s\S]*generationRequestInFlight = false/);
  assert.match(functionBody('post'), /error\.httpStatus = response\.status/);
  assert.match(app, /generationStage === ['"]generate-music['"] && pending && !Number\.isInteger\(error\.httpStatus\)/);
});

test('background, foreground, and pageshow preserve the ordinary recording UI without another paid request', async () => {
  const browser = browserHarness();
  browser.element('#token').value = 'sk-test';
  browser.element('#idea').value = 'Monsoon';
  browser.element('#vibe').value = 'Warm folk';
  browser.element('#language').value = 'gu';

  const submission = browser.submit();
  await new Promise(setImmediate);

  browser.background();
  browser.foreground();

  assert.equal(browser.element('#track-title').textContent, 'Your mehfil is recording');
  assert.equal(browser.element('#track-subtitle').textContent, 'View the performance while you wait');
  assert.equal(browser.element('#notice').textContent, 'The harmonium warms up…');
  assert.equal(browser.element('#performance-status').textContent, 'The harmonium warms up…');
  assert.equal(browser.element('#check-generation').hidden, true);
  assert.equal(browser.state.recoveryStarts, 0);
  assert.equal(browser.state.generatePosts, 1);
  assert.equal(browser.state.diagnosticRetryLabel, null);

  browser.state.resolveGenerate({ status: 'pending', jobId: 'AbCdEfGhIjKlMnOpQrStUvWx' });
  await submission;
  browser.pageshow();

  assert.equal(browser.state.recoveryStarts, 1);
  assert.equal(browser.state.generatePosts, 1);
  assert.equal(browser.element('#track-title').textContent, 'Your mehfil is recording');
  assert.equal(browser.element('#track-subtitle').textContent, 'View the performance while you wait');
  assert.equal(browser.state.diagnosticRetryLabel, null);
});

test('a lyric request lost across background and foreground retries silently before the paid request', async () => {
  const browser = browserHarness({ deferFirstLyrics: true });
  browser.element('#token').value = 'sk-test';
  browser.element('#idea').value = 'Dhruv is King';
  browser.element('#vibe').value = 'Hip hop';

  const submission = browser.submit();
  await new Promise(setImmediate);
  browser.background();
  browser.foreground();
  browser.state.rejectLyrics(new TypeError('Load failed'));
  await new Promise(setImmediate);

  assert.equal(browser.state.writeLyricsPosts, 2);
  assert.equal(browser.state.generatePosts, 1);
  assert.equal(browser.element('#track-title').textContent, 'Your mehfil is recording');
  assert.equal(browser.element('#track-subtitle').textContent, 'View the performance while you wait');
  assert.notEqual(browser.element('#notice').textContent, 'Load failed');

  browser.state.resolveGenerate({ status: 'pending', jobId: 'AbCdEfGhIjKlMnOpQrStUvWx' });
  await submission;
});

test('a lyric network failure without a lifecycle interruption remains actionable', async () => {
  const browser = browserHarness({ deferFirstLyrics: true });
  browser.element('#token').value = 'sk-test';
  browser.element('#idea').value = 'Dhruv is King';

  const submission = browser.submit();
  await new Promise(setImmediate);
  browser.state.rejectLyrics(new TypeError('Load failed'));
  await submission;

  assert.equal(browser.state.writeLyricsPosts, 1);
  assert.equal(browser.state.generatePosts, 0);
  assert.equal(browser.element('#notice').textContent, 'Load failed');
  assert.equal(browser.element('#track-title').textContent, 'No recording was made');
});

test('only a genuine status outage reveals a neutral Check generation action', () => {
  const browser = browserHarness();
  browser.state.pending = {
    jobId: 'AbCdEfGhIjKlMnOpQrStUvWx',
    lyricSheet: { title: 'Monsoon Song', lyricsNative: 'વરસાદ' }
  };
  browser.foreground();
  assert.equal(browser.state.diagnosticRetryLabel, null);

  browser.state.recoveryOptions.onRetryable({ status: 503, message: 'Recording recovery is temporarily unavailable.' }, browser.state.current);

  assert.equal(browser.element('#check-generation').hidden, false);
  assert.equal(browser.state.diagnosticRetryLabel, 'Check generation');
  assert.equal(browser.element('#notice').textContent, 'We’re having trouble checking your recording. It may still be finishing.');
  assert.doesNotMatch(browser.element('#notice').textContent, /checkpoint|recovery|aborted|retrying/i);
  assert.equal(browser.state.generatePosts, 0);
});
test('standalone generation is extracted behind a thin form caller',()=>{assert.match(app,/async function generateSong\(\{ idea, vibe, language \}, hooks = \{\}\)/);const handler=app.slice(app.indexOf("form.addEventListener('submit'"),app.indexOf("performanceClose.addEventListener"));assert.match(handler,/clearLoadedSong\(\)[\s\S]*resetPeek\(\)[\s\S]*await generateSong/);});
test('host room credentials remain session-only and authenticate first',()=>{assert.match(app,/sessionStorage\.setItem\(ROOM_SESSION_KEY/);assert.doesNotMatch(app,/localStorage/);assert.match(app,/new WebSocket\(details\.socketUrl\)/);assert.match(app,/roomSocket\.send\(JSON\.stringify\(\{ type:'auth-host', secret:details\.hostSecret \}\)\)/);assert.doesNotMatch(app,/details\.socketUrl\s*\+.*hostSecret|URLSearchParams.*hostSecret/);});
test('room recording is explicit and preserves lifecycle order',()=>{const body=functionBody('recordRoomRequest');const started=body.indexOf("type:'recording-started'");const generated=body.indexOf('await generateSong');const lyrics=body.indexOf("type:'lyrics-ready'");const upload=body.indexOf('await uploadCurrentSong');const ready=body.indexOf("type:'song-ready'");assert.ok(started<generated&&generated<lyrics&&lyrics<upload&&upload<ready);assert.match(body,/item\.status !== 'accepted'/);assert.match(body,/run !== generationRun/);assert.match(body,/type:'recording-failed'/);});
test('host panel exposes queue management controls',()=>{for(const id of ['open-room','room-panel','room-link','host-queue','close-room'])assert.match(html,new RegExp(`id="${id}"`));for(const label of ['Accept','Decline','Record','Kick'])assert.ok(app.includes(`'${label}'`));});
