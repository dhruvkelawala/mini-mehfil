const form = document.querySelector('#song-form');
const tokenInput = document.querySelector('#token');
const ideaInput = document.querySelector('#idea');
const vibeInput = document.querySelector('#vibe');
const languageSelect = document.querySelector('#language');
const peek = document.querySelector('#peek');
const peekToggle = document.querySelector('#peek-toggle');
const lyricReveal = document.querySelector('#lyric-reveal');
const revealLanguage = document.querySelector('#reveal-language');
const revealLines = document.querySelector('#reveal-lines');
const revealButton = document.querySelector('#reveal-token');
const notice = document.querySelector('#notice');
const generateButton = document.querySelector('.generate');
const buttonLabel = document.querySelector('.button-label');
const audio = document.querySelector('#audio');
const player = document.querySelector('#player-shell');
const playButton = document.querySelector('#play');
const seek = document.querySelector('#seek');
const timecode = document.querySelector('#timecode');
const trackTitle = document.querySelector('#track-title');
const trackSubtitle = document.querySelector('#track-subtitle');
const download = document.querySelector('#download');
const scene = document.querySelector('.scene');
const main = document.querySelector('main');
const topbar = document.querySelector('.topbar');
const performanceView = document.querySelector('#performance');
const performanceClose = document.querySelector('#performance-close');
const performanceStatus = document.querySelector('#performance-status');
const performanceReplay = document.querySelector('#performance-replay');

const writingLines = [
  'Listening to your idea…',
  'Finding the language…',
  'Looking for a rhyme…',
  'Shaping the chorus…'
];
const recordingLines = [
  'The harmonium warms up…',
  'Tabla finds the taal…',
  'The singer clears their throat…',
  'First take, everyone quiet…',
  'Almost there — good songs take a moment…'
];

let waitingTimer;
let objectUrl;
let lyricSheet = null;
let hasRevealed = false;
let generating = false;
let typingRun = 0;

function updateClock() {
  document.querySelector('#clock').textContent = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date()).toLowerCase();
}
updateClock();
setInterval(updateClock, 30000);

revealButton.addEventListener('click', () => {
  const revealing = tokenInput.type === 'password';
  tokenInput.type = revealing ? 'text' : 'password';
  revealButton.textContent = revealing ? 'Hide' : 'Show';
  revealButton.setAttribute('aria-label', revealing ? 'Hide token' : 'Show token');
  revealButton.setAttribute('aria-pressed', String(revealing));
});

function resetPeek() {
  typingRun += 1;
  lyricSheet = null;
  hasRevealed = false;
  peek.hidden = true;
  lyricReveal.hidden = true;
  revealLines.textContent = '';
  delete revealLines.dataset.render;
  peekToggle.setAttribute('aria-expanded', 'false');
  peekToggle.querySelector('strong').textContent = 'Reveal lyrics';
  peekToggle.querySelector('small').textContent = "Wanna be surprised? Don't click me.";
}

// Lines arrive one at a time, like someone writing them in front of you.
function typeOut(text) {
  const run = ++typingRun;
  const lines = text.split('\n').filter(line => line.trim());
  let index = 0;
  revealLines.textContent = '';
  revealLines.dataset.render = 'typing';
  if (!lines.length) return;
  const tick = () => {
    if (run !== typingRun) return;
    revealLines.append(createLyricLine(lines[index]));
    revealLines.scrollTop = revealLines.scrollHeight;
    index += 1;
    if (index < lines.length) setTimeout(tick, 55);
  };
  tick();
}

function createLyricLine(line) {
  const element = document.createElement('span');
  element.className = /^\[.+\]$/.test(line) ? 'lyric-line lyric-cue' : 'lyric-line';
  element.textContent = line.replace(/^\[(.+)\]$/, '$1');
  return element;
}

function buildLyricLines(lines, mode) {
  const fragment = document.createDocumentFragment();
  lines.forEach(line => fragment.append(createLyricLine(line)));
  revealLines.replaceChildren(fragment);
  revealLines.dataset.render = mode;
}

function showFullLyrics() {
  typingRun += 1;
  const lines = lyricLines();
  buildLyricLines(lines, 'full');
}

function lyricLines() {
  return (lyricSheet?.lyricsRoman || '').split('\n').filter(line => line.trim());
}

function languageLabel() {
  if (!lyricSheet) return '';
  return lyricSheet.isLatinScript
    ? lyricSheet.language
    : `${lyricSheet.language} · ${lyricSheet.nativeScriptName}`;
}

function updateScenePerformance() {
  scene.classList.toggle('is-performing', generating || !audio.paused);
}

function openPerformance() {
  performanceView.hidden = false;
  document.body.classList.add('performance-open');
  main.inert = true;
  topbar.inert = true;
  notice.setAttribute('aria-hidden', 'true');
  performanceClose.focus();
}

function closePerformance() {
  performanceView.hidden = true;
  document.body.classList.remove('performance-open');
  main.inert = false;
  topbar.inert = false;
  notice.removeAttribute('aria-hidden');
  performanceStatus.textContent = '';
  form.querySelector('input:not([disabled]), select:not([disabled]), button:not([disabled])')?.focus();
}

function showPerformanceStatus(message) {
  performanceView.dataset.stage = 'waiting';
  performanceStatus.textContent = message;
}

function renderPlaybackLyrics() {
  if (!lyricSheet || performanceView.hidden) return;
  performanceView.dataset.stage = 'playing';
  performanceStatus.textContent = '';
  peek.hidden = true;
  lyricReveal.hidden = false;
  revealLanguage.textContent = languageLabel();
  if (hasRevealed) {
    if (revealLines.dataset.render !== 'full') showFullLyrics();
    return;
  }
  const lines = lyricLines();
  const pacedDuration = audio.duration * .9;
  const progress = pacedDuration > 0 ? Math.min(audio.currentTime / pacedDuration, 1) : 0;
  const shownCount = Math.min(lines.length, Math.floor(progress * lines.length));
  if (revealLines.dataset.render !== 'paced') buildLyricLines(lines, 'paced');
  const renderedLines = [...revealLines.children];
  renderedLines.forEach((line, index) => {
    line.hidden = index >= shownCount;
    line.classList.remove('lyric-current');
  });
  const currentLine = renderedLines.slice(0, shownCount).reverse().find(line => !line.classList.contains('lyric-cue'));
  currentLine?.classList.add('lyric-current');
  revealLines.scrollTop = revealLines.scrollHeight;
}

peekToggle.addEventListener('click', () => {
  if (!lyricSheet) return;
  const opening = lyricReveal.hidden;
  lyricReveal.hidden = !opening;
  peekToggle.setAttribute('aria-expanded', String(opening));
  peekToggle.querySelector('strong').textContent = opening ? 'Hide lyrics' : 'Reveal lyrics';
  peekToggle.querySelector('small').textContent = opening
    ? 'Too late now.'
    : "Wanna be surprised? Don't click me.";
  if (!opening) return;
  revealLanguage.textContent = languageLabel();
  // Type them out the first time; after that just show them instantly.
  if (hasRevealed) showFullLyrics();
  else typeOut(lyricSheet.lyricsRoman);
  hasRevealed = true;
});

function setBusy(busy, lines) {
  generateButton.disabled = busy;
  tokenInput.disabled = busy;
  ideaInput.disabled = busy;
  vibeInput.disabled = busy;
  languageSelect.disabled = busy;
  clearInterval(waitingTimer);
  if (!busy) return;
  let index = 0;
  notice.className = 'notice working';
  notice.textContent = lines[index];
  showPerformanceStatus(lines[index]);
  waitingTimer = setInterval(() => {
    index = Math.min(index + 1, lines.length - 1);
    notice.textContent = lines[index];
    showPerformanceStatus(lines[index]);
  }, 6000);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function decodeHexAudio(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
}

async function post(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({ error: 'The server returned an unreadable response.' }));
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}

function loadSong(source, title) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  const isUrl = /^https?:\/\//i.test(source);
  objectUrl = isUrl ? null : decodeHexAudio(source);
  audio.src = isUrl ? source : objectUrl;
  trackTitle.textContent = title || 'Your Mehfil recording';
  trackSubtitle.textContent = 'Fresh from MiniMax Music 3';
  playButton.disabled = false;
  download.href = audio.src;
  download.setAttribute('aria-disabled', 'false');
  performanceReplay.hidden = true;
  renderPlaybackLyrics();
  audio.play().catch(() => {});
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  notice.textContent = '';
  if (!form.reportValidity()) return;
  audio.pause();
  audio.currentTime = 0;
  resetPeek();
  openPerformance();
  performanceReplay.hidden = true;
  generating = true;
  updateScenePerformance();
  let generationFailed = false;

  try {
    setBusy(true, writingLines);
    lyricSheet = await post('/api/write-lyrics', {
      token: tokenInput.value,
      idea: ideaInput.value,
      vibe: vibeInput.value,
      language: languageSelect.value
    });

    // The words exist now. Offer the peek, then record whether or not it is taken.
    peek.hidden = false;
    setBusy(true, recordingLines);

    // The native script is what gets sung: the music model pronounces it best.
    const result = await post('/api/generate', {
      token: tokenInput.value,
      prompt: lyricSheet.prompt || vibeInput.value,
      lyrics: lyricSheet.lyricsNative || lyricSheet.lyricsRoman
    });
    const source = result?.data?.audio || result?.audio?.url || result?.audio;
    if (!source || typeof source !== 'string') throw new Error('MiniMax succeeded but did not return an audio file.');

    loadSong(source, lyricSheet.title);
    notice.className = 'notice working';
    notice.textContent = 'Your recording is ready.';
  } catch (error) {
    notice.className = 'notice';
    notice.textContent = error.message;
    generationFailed = true;
  } finally {
    generating = false;
    updateScenePerformance();
    setBusy(false, []);
    if (generationFailed) closePerformance();
  }
});

performanceClose.addEventListener('click', closePerformance);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !performanceView.hidden) closePerformance();
});
performanceReplay.addEventListener('click', () => {
  performanceReplay.hidden = true;
  hasRevealed = false;
  lyricReveal.hidden = false;
  revealLines.textContent = '';
  delete revealLines.dataset.render;
  audio.currentTime = 0;
  renderPlaybackLyrics();
  audio.play().catch(() => {});
});

playButton.addEventListener('click', () => {
  if (audio.paused) audio.play(); else audio.pause();
});
audio.addEventListener('play', () => {
  player.classList.add('playing');
  performanceReplay.hidden = true;
  updateScenePerformance();
  renderPlaybackLyrics();
  playButton.querySelector('span').textContent = '❚❚';
  playButton.setAttribute('aria-label', 'Pause');
});
audio.addEventListener('pause', () => {
  player.classList.remove('playing');
  updateScenePerformance();
  playButton.querySelector('span').textContent = '▶';
  playButton.setAttribute('aria-label', 'Play');
});
audio.addEventListener('timeupdate', () => {
  seek.value = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  timecode.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
  renderPlaybackLyrics();
});
audio.addEventListener('loadedmetadata', () => {
  timecode.textContent = `0:00 / ${formatTime(audio.duration)}`;
});
seek.addEventListener('input', () => {
  if (audio.duration) {
    audio.currentTime = (Number(seek.value) / 100) * audio.duration;
    renderPlaybackLyrics();
  }
});
audio.addEventListener('ended', () => {
  if (!performanceView.hidden) performanceReplay.hidden = false;
});
