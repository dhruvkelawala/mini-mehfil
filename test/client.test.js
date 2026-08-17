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
  const open = app.indexOf('{', app.indexOf(')', start));
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

function functionSource(name) {
  const plain = app.indexOf(`function ${name}(`);
  const asyncStart = app.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 && (plain < 0 || asyncStart < plain) ? asyncStart : plain;
  assert.notEqual(start, -1, `${name} should exist`);
  const open = app.indexOf('{', app.indexOf(')', start));
  let depth = 0;
  for (let index = open; index < app.length; index += 1) {
    if (app[index] === '{') depth += 1;
    if (app[index] === '}') depth -= 1;
    if (depth === 0) return app.slice(start, index + 1);
  }
  assert.fail(`${name} should have a complete source`);
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

test('a room upload keeps the finished audio paired with its own lyric sheet', async () => {
  const uploadCurrentSong = Function(
    'shareReference', 'lyricSheet', 'generationRun', 'shareButton',
    'setShareLabel', 'shareUrl', 'post', 'copyShareLink', 'notice',
    `return (${functionSource('uploadCurrentSong')})`
  )(
    'audio-reference-b',
    { title: 'Old song', language: 'English' },
    2,
    { disabled: false },
    () => {},
    null,
    async (_url, payload) => {
      assert.equal(payload.title, 'New song');
      assert.equal(payload.lyricsNative, 'new words');
      return { url: 'https://share.example/s/AbCdEfGhIjKlMnOp' };
    },
    async () => {},
    { className: '', textContent: '' }
  );

  await uploadCurrentSong({
    copy: false,
    requestRun: 2,
    requestReference: 'audio-reference-b',
    requestSheet: {
      title: 'New song',
      language: 'Hindi',
      nativeScriptName: 'Devanagari',
      isLatinScript: false,
      lyricsNative: 'new words',
      lyricsRoman: 'naye bol'
    }
  });
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
test('main generation publishes its finished song into an active room', () => {
  const handler = app.slice(
    app.indexOf("form.addEventListener('submit'"),
    app.indexOf("performanceClose.addEventListener")
  );
  assert.match(handler, /publishGeneratedSongToRoom/);
  const publish = functionSource('publishGeneratedSongToRoom');
  assert.match(publish, /uploadCurrentSong/);
  assert.match(publish, /type: 'song-shared'/);
  assert.match(publish, /shareId/);
  assert.match(publish, /lyrics/);
});
test('host room credentials remain session-only and authenticate first',()=>{assert.match(app,/sessionStorage\.setItem\(ROOM_SESSION_KEY/);assert.doesNotMatch(app,/localStorage/);assert.match(app,/new WebSocket\(details\.socketUrl\)/);assert.match(app,/socket\.send\(JSON\.stringify\(\{[\s\S]*type: 'auth-host',[\s\S]*secret: details\.hostSecret[\s\S]*\}\)\)/);assert.doesNotMatch(app,/details\.socketUrl\s*\+.*hostSecret|URLSearchParams.*hostSecret/);});
test('host player publishes authoritative room playback', () => {
  const playback = functionSource('applyHostRoomPlayback');
  const controlled = functionSource('controlledRoomSong');
  assert.match(controlled, /roomSnapshot\?\.currentSong/);
  assert.match(controlled, /currentHostShareId\(\) === song\.shareId/);
  assert.match(playback, /playback\.changedAt/);
  assert.match(playback, /roomPlaybackPositionMs/);
  assert.match(playback, /attemptPlayback\('room-sync'\)/);
  assert.match(playback, /audio\.pause\(\)/);
  assert.match(app, /type: 'playback-updated'/);
  assert.match(app, /status: audio\.paused \? 'paused' : 'playing'/);
  assert.match(html, /id="room-playback"[\s\S]*Your player controls the music for everyone/);
});
test('room recording lifecycle executes paid work and events in runtime order',async()=>{const lifecycle=Function(`return (${functionSource('runRoomRecordingLifecycle')})`)();const sequence=[];const sheet={title:'Rain',language:'Hindi',nativeScriptName:'Devanagari',isLatinScript:false,lyricsNative:'बारिश',lyricsRoman:'baarish'};const result=await lifecycle({requestId:'q1',run:1,isCurrent:()=>true,send:event=>{sequence.push(event.type);return true},generate:async hooks=>{sequence.push('generate');hooks.onLyrics(sheet);sequence.push('generated')},upload:async()=>{sequence.push('upload');return'https://share.example/s/AbCdEfGhIjKlMnOp'}});assert.equal(result,'ready');assert.deepEqual(sequence,['recording-started','generate','lyrics-ready','generated','upload','song-ready']);const failed=[];await lifecycle({requestId:'q2',run:1,isCurrent:()=>true,send:event=>{failed.push(event.type);return true},generate:async hooks=>hooks.onLyrics(sheet),upload:async()=>{throw new Error('bucket')}});assert.deepEqual(failed,['recording-started','lyrics-ready','recording-failed']);let generated=false,uploaded=false;const disconnected=await lifecycle({requestId:'q3',run:1,isCurrent:()=>true,send:()=>false,generate:async()=>{generated=true},upload:async()=>{uploaded=true}});assert.equal(disconnected,'disconnected');assert.equal(generated,false);assert.equal(uploaded,false);const body=functionBody('recordRoomRequest');assert.match(body,/item\.status !== 'accepted'/);assert.match(body,/runRoomRecordingLifecycle/);assert.match(body,/room is reconnecting/);});
test('host room treats auth close as terminal and waits for expiry acknowledgement',()=>{const connect=functionBody('connectHostRoom');assert.match(connect,/event\.code === 4001[\s\S]*clearRoomSession/);assert.match(connect,/if \(roomTerminal\) return/);const clear=functionBody('clearRoomSession');assert.match(clear,/roomTerminal = true/);const closeHandler=app.slice(app.indexOf("document.querySelector('#close-room')"));assert.match(closeHandler,/roomSend\(\{ type: 'room-expired' \}\)[\s\S]*setTimeout/);assert.doesNotMatch(closeHandler,/roomSend\(\{ type: 'room-expired' \}\);\s*clearRoomSession/);});
test('host reorder targets use full queue indices when terminal rows are hidden',()=>{const targets=Function(`return (${functionSource('roomReorderTargets')})`)();const queue=[{id:'done',status:'ready'},{id:'a',status:'pending'},{id:'declined',status:'declined'},{id:'b',status:'accepted'}];assert.deepEqual(targets(queue,'a'),{up:1,down:3});assert.deepEqual(targets(queue,'b'),{up:1,down:3});});
test('host view covers every participant, requester names, and Worker-origin setlist links',()=>{const view=Function(`return (${functionSource('hostRoomView')})`)();const state={participants:[{id:'p1',name:'Ada'},{id:'p2',name:''}],queue:[{id:'q1',participantId:'p1',idea:'Rain',status:'ready'},{id:'q2',participantId:'p2',idea:'Sun',status:'declined'}],setlist:[{shareId:'AbCdEfGhIjKlMnOp',title:'Rain'}]};assert.deepEqual(view(state,'https://worker.example/r/ABCDEFGH'),{participants:[{id:'p1',name:'Ada'},{id:'p2',name:'Listener'}],queue:[{...state.queue[0],requesterName:'Ada'},{...state.queue[1],requesterName:'Listener'}],setlist:[{...state.setlist[0],url:'https://worker.example/s/AbCdEfGhIjKlMnOp'}]});const render=functionBody('renderHostRoom');const participant=functionBody('participantRow');const queue=functionBody('queueRow');assert.match(render,/hostParticipants\.replaceChildren/);assert.match(participant,/participant\.name/);assert.match(queue,/requesterName/);assert.match(render,/hostSetlist\.replaceChildren/);});
test('host can abandon a room that cannot reconnect',()=>{const closeHandler=app.slice(app.indexOf("document.querySelector('#close-room')"));assert.match(closeHandler,/if \(!roomSend\(\{ type: 'room-expired' \}\)\)[\s\S]*removed from this device[\s\S]*clearRoomSession\(\)[\s\S]*return/);const send=functionBody('roomSend');assert.match(send,/return false/);assert.match(send,/roomAuthenticated/);assert.match(send,/return true/);});
test('host panel follows the song composer in the primary task column', () => {
  for (const id of [
    'open-room', 'room-panel', 'room-link', 'host-participants',
    'host-queue', 'host-setlist', 'dismiss-room', 'close-room'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  const identityStart = html.indexOf('<section class="identity"');
  const identity = html.slice(identityStart, html.indexOf('</section>', identityStart));
  assert.match(topbar, /id="open-room"/);
  assert.doesNotMatch(identity, /id="open-room"|id="room-panel"/);
  const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
  assert.match(main, /id="song-form"[\s\S]*id="room-panel"/);
  assert.match(app, /setRoomPanelOpen\(roomPanel\.hidden/);
  assert.match(app, /document\.querySelector\('#dismiss-room'\)/);
  for (const label of ['Accept', 'Decline', 'Record', 'Kick']) {
    assert.ok(app.includes(`'${label}'`));
  }
});
