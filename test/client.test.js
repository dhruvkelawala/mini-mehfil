const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const recovery = fs.readFileSync(path.join(__dirname, '..', 'public', 'generation-recovery.js'), 'utf8');

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

test('player controls use SVG icons instead of platform-dependent glyphs', () => {
  const start = html.indexOf('<section class="player-shell"');
  const player = html.slice(start, html.indexOf('</section>', start));
  assert.doesNotMatch(player, /[▶❚↗↓✓↻]/);
  assert.match(player, /id="play"[\s\S]*play-icon[\s\S]*pause-icon/);
  assert.match(player, /id="share"[\s\S]*<svg class="player-icon"/);
  assert.match(player, /id="download"[\s\S]*<svg class="player-icon"/);
  assert.doesNotMatch(app, /shareButton\.innerHTML|playButton\.querySelector\(['"]span['"]\)/);
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
});
