const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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
