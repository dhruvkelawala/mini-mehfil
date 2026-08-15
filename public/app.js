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
const shareButton = document.querySelector('#share');
const download = document.querySelector('#download');
const scene = document.querySelector('.scene');
const main = document.querySelector('main');
const topbar = document.querySelector('.topbar');
const performanceView = document.querySelector('#performance');
const performanceClose = document.querySelector('#performance-close');
const performanceStatus = document.querySelector('#performance-status');
const performanceTiming = document.querySelector('#performance-timing');
const performanceReplay = document.querySelector('#performance-replay');
const performanceButton = document.querySelector('#view-performance');
const playerHome = document.querySelector('#player-home');
const diagnostics = window.MehfilMediaDiagnostics || {
  enabled: false,
  record() {}, fatal() {}, attachMedia() {}, setRetryHandler() {},
  snapshot() { return null; }, redactUrl() { return '[diagnostics unavailable]'; }
};

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
let generationRun = 0;
let shareReference = null;
let shareUrl = null;
let performanceAvailable = false;
let performanceOpener = null;

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
function typeOut(lines) {
  const run = ++typingRun;
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
  element.className = line.cue ? 'lyric-line lyric-cue' : 'lyric-line';
  if (line.cue) {
    element.textContent = line.primary.replace(/^\[(.+)\]$/, '$1');
    return element;
  }
  const primary = document.createElement('span');
  primary.className = 'lyric-primary';
  primary.textContent = line.primary;
  element.append(primary);
  if (line.secondary) {
    const secondary = document.createElement('span');
    secondary.className = 'lyric-secondary';
    secondary.textContent = line.secondary;
    element.append(secondary);
  }
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
  const roman = (lyricSheet?.lyricsRoman || '').split('\n').filter(line => line.trim());
  const native = (lyricSheet?.lyricsNative || '').split('\n').filter(line => line.trim());
  const useNative = !lyricSheet?.isLatinScript && native.length;
  const primary = useNative ? native : roman;
  return primary.map((primaryLine, index) => {
    const romanLine = roman[index] || '';
    const cue = /^\[.+\]$/.test(romanLine || primaryLine);
    return {
      cue,
      primary: cue ? (romanLine || primaryLine) : primaryLine,
      secondary: useNative && !cue && romanLine && romanLine !== primaryLine ? romanLine : ''
    };
  });
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

function openPerformance(opener = document.activeElement) {
  if (!performanceAvailable) return;
  diagnostics.record('performance-open', { hasAudioSource: Boolean(audio.src) });
  performanceOpener = opener;
  performanceView.hidden = false;
  performanceView.append(player);
  performanceButton.hidden = true;
  document.body.classList.add('performance-open');
  main.inert = true;
  topbar.inert = true;
  notice.setAttribute('aria-hidden', 'true');
  if (audio.src) {
    renderPlaybackLyrics();
    performanceReplay.hidden = !audio.ended;
  }
  performanceClose.focus();
}

function closePerformance(reason = 'unknown') {
  diagnostics.record('performance-close', { reason, hasAudioSource: Boolean(audio.src) });
  playerHome.after(player);
  performanceView.hidden = true;
  performanceButton.hidden = !performanceAvailable;
  document.body.classList.remove('performance-open');
  main.inert = false;
  topbar.inert = false;
  notice.removeAttribute('aria-hidden');
  const focusTarget = performanceOpener && !performanceOpener.disabled
    ? performanceOpener
    : performanceButton;
  focusTarget?.focus();
}

function showPerformanceStatus(message) {
  performanceView.dataset.stage = 'waiting';
  performanceStatus.textContent = message;
}

function setPlaybackStatus(stage, message) {
  performanceView.dataset.stage = stage;
  performanceStatus.textContent = message;
  notice.className = message ? 'notice working' : 'notice';
  notice.textContent = message;
}

function renderPlaybackLyrics() {
  if (!lyricSheet || performanceView.hidden) return;
  peek.hidden = true;
  lyricReveal.hidden = false;
  revealLanguage.textContent = languageLabel();
  performanceTiming.hidden = hasRevealed;
  if (hasRevealed) {
    if (revealLines.dataset.render !== 'full') showFullLyrics();
    return;
  }
  const lines = lyricLines();
  const pacedDuration = audio.duration * .9;
  const progress = pacedDuration > 0 ? Math.min(audio.currentTime / pacedDuration, 1) : 0;
  const spokenLineCount = lines.filter(line => !line.cue).length;
  // The first lyric should arrive as playback begins, not one full lyric interval later.
  const shownSpokenCount = Math.min(spokenLineCount, Math.ceil(progress * spokenLineCount));
  if (revealLines.dataset.render !== 'paced') buildLyricLines(lines, 'paced');
  const renderedLines = [...revealLines.children];
  let spokenSeen = 0;
  renderedLines.forEach((line, index) => {
    const lyric = lines[index];
    if (!lyric.cue) {
      line.hidden = ++spokenSeen > shownSpokenCount;
      return;
    }
    // A cue surfaces with the spoken line that follows it; a trailing cue
    // (like a final [Outro]) surfaces once every spoken line is on screen.
    const isTrailingCue = spokenSeen === spokenLineCount;
    line.hidden = isTrailingCue ? shownSpokenCount < spokenLineCount : shownSpokenCount <= spokenSeen;
  });
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
  else typeOut(lyricLines());
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
  const startedAt = performance.now();
  diagnostics.record('api-request-start', { endpoint: url });
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    diagnostics.record('api-request-rejected', {
      endpoint: url,
      elapsedMs: Math.round(performance.now() - startedAt),
      error
    });
    throw error;
  }
  diagnostics.record('api-response', {
    endpoint: url,
    status: response.status,
    ok: response.ok,
    elapsedMs: Math.round(performance.now() - startedAt),
    contentType: response.headers.get('content-type')
  });
  const result = await response.json().catch(error => {
    diagnostics.record('api-json-rejected', { endpoint: url, error });
    return { error: 'The server returned an unreadable response.' };
  });
  if (!response.ok) {
    const error = new Error(result.error || 'Something went wrong.');
    diagnostics.record('api-http-error', { endpoint: url, status: response.status, error });
    throw error;
  }
  return result;
}

function setShareLabel(label) {
  shareButton.querySelector('span').textContent = label;
}

function clearLoadedSong() {
  generationRun += 1;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  seek.value = 0;
  timecode.textContent = '0:00 / 0:00';
  playButton.disabled = true;
  playButton.setAttribute('aria-label', 'Play');
  download.removeAttribute('href');
  download.setAttribute('aria-disabled', 'true');
  shareReference = null;
  shareUrl = null;
  shareButton.disabled = true;
  setShareLabel('Share');
  performanceReplay.hidden = true;
}

async function attemptPlayback(trigger) {
  diagnostics.record('play-attempt', {
    trigger,
    media: diagnostics.snapshot(audio),
    userActivation: diagnostics.userActivation?.() || null
  });
  try {
    await audio.play();
    diagnostics.record('play-resolved', { trigger, media: diagnostics.snapshot(audio) });
    return true;
  } catch (error) {
    diagnostics.fatal('audio.play() rejected', error, audio, { trigger });
    const message = error?.name === 'NotAllowedError'
      ? 'Your song is ready — tap Play.'
      : 'Playback hit a snag — tap Play to try again, or Save your song.';
    setPlaybackStatus('waiting', message);
    return false;
  }
}

diagnostics.attachMedia(audio);
diagnostics.setRetryHandler(() => { void attemptPlayback('diagnostic-retry'); });

function loadSong(source, title, reference) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  const isUrl = /^https?:\/\//i.test(source);
  objectUrl = isUrl ? null : decodeHexAudio(source);
  audio.src = isUrl ? source : objectUrl;
  diagnostics.record('audio-source-selected', {
    sourceType: isUrl ? 'remote-url' : 'inline-hex',
    source: isUrl ? diagnostics.redactUrl(source) : '[inline audio redacted]',
    sourceCharacters: source.length
  });
  trackTitle.textContent = title || 'Your Mehfil recording';
  trackSubtitle.textContent = 'Fresh from MiniMax Music 3';
  shareReference = reference || null;
  shareUrl = null;
  shareButton.disabled = !shareReference;
  setShareLabel('Share');
  playButton.disabled = false;
  download.href = audio.src;
  download.setAttribute('aria-disabled', 'false');
  performanceAvailable = true;
  performanceButton.hidden = !performanceView.hidden;
  performanceReplay.hidden = true;
  renderPlaybackLyrics();
  void attemptPlayback('generation-complete');
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  notice.textContent = '';
  if (!form.reportValidity()) return;
  clearLoadedSong();
  resetPeek();
  performanceAvailable = true;
  performanceButton.hidden = false;
  openPerformance(generateButton);
  generating = true;
  updateScenePerformance();
  let generationFailed = false;
  let generationStage = 'write-lyrics';
  trackTitle.textContent = 'Your mehfil is recording';
  trackSubtitle.textContent = 'View the performance while you wait';

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
    generationStage = 'generate-music';

    // The native script is what gets sung: the music model pronounces it best.
    const result = await post('/api/generate', {
      token: tokenInput.value,
      prompt: lyricSheet.prompt || vibeInput.value,
      lyrics: lyricSheet.lyricsNative || lyricSheet.lyricsRoman
    });
    diagnostics.record('generation-result', {
      traceId: result?.trace_id || result?.traceId || result?.data?.trace_id || null,
      hasDataAudio: typeof result?.data?.audio === 'string',
      hasAudioUrl: typeof result?.audio?.url === 'string',
      audioValueType: typeof result?.audio
    });
    const source = result?.data?.audio || result?.audio?.url || result?.audio;
    if (!source || typeof source !== 'string') throw new Error('MiniMax succeeded but did not return an audio file.');

    generationStage = 'load-song';
    loadSong(source, lyricSheet.title, result.share_ref);
    notice.className = 'notice working';
    notice.textContent = 'Your recording is ready.';
  } catch (error) {
    diagnostics.fatal('Generation flow failed before playback', error, audio, { generationStage });
    notice.className = 'notice';
    notice.textContent = error.message;
    trackTitle.textContent = 'No recording was made';
    trackSubtitle.textContent = 'Try the mehfil again';
    performanceAvailable = false;
    generationFailed = true;
  } finally {
    generating = false;
    updateScenePerformance();
    setBusy(false, []);
    if (generationFailed) closePerformance('generation-failed');
  }
});

performanceClose.addEventListener('click', () => closePerformance('user-close-button'));
performanceButton.addEventListener('click', () => openPerformance(performanceButton));
document.addEventListener('keydown', event => {
  if (performanceView.hidden) return;
  if (event.key === 'Escape') {
    closePerformance('escape-key');
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = [...performanceView.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href]:not([aria-disabled="true"])')]
    .filter(control => !control.hidden && control.getClientRects().length);
  if (!controls.length) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (!performanceView.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  }
});
performanceReplay.addEventListener('click', () => {
  performanceReplay.hidden = true;
  hasRevealed = false;
  lyricReveal.hidden = false;
  revealLines.textContent = '';
  delete revealLines.dataset.render;
  audio.currentTime = 0;
  renderPlaybackLyrics();
  void attemptPlayback('replay-button');
});

playButton.addEventListener('click', () => {
  if (audio.paused) void attemptPlayback('play-button'); else audio.pause();
});
audio.addEventListener('play', () => {
  player.classList.add('playing');
  performanceReplay.hidden = true;
  setPlaybackStatus('playing', '');
  updateScenePerformance();
  renderPlaybackLyrics();
  playButton.setAttribute('aria-label', 'Pause');
});
audio.addEventListener('pause', () => {
  player.classList.remove('playing');
  updateScenePerformance();
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
audio.addEventListener('error', () => {
  diagnostics.record('playback-recovery-visible', {
    reason: 'media-error',
    media: diagnostics.snapshot(audio)
  });
  player.classList.remove('playing');
  scene.classList.remove('is-performing');
  playButton.setAttribute('aria-label', 'Play');
  setPlaybackStatus('waiting', 'This recording cannot play right now — try Play again or Save your song.');
});
seek.addEventListener('input', () => {
  if (audio.duration) {
    performanceReplay.hidden = true;
    audio.currentTime = (Number(seek.value) / 100) * audio.duration;
    renderPlaybackLyrics();
  }
});
audio.addEventListener('ended', () => {
  if (!performanceView.hidden) performanceReplay.hidden = false;
});

async function copyShareLink(url) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }
  const field = document.createElement('textarea');
  field.value = url;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Copy the link from the message below.');
}

shareButton.addEventListener('click', async () => {
  if (!shareReference || !lyricSheet) return;
  const requestRun = generationRun;
  const requestReference = shareReference;
  const requestIsCurrent = () => requestRun === generationRun && requestReference === shareReference;
  shareButton.disabled = true;
  setShareLabel('Sharing');
  try {
    let requestedUrl = shareUrl;
    if (!shareUrl) {
      const result = await post('/api/share', {
        shareRef: shareReference,
        title: lyricSheet.title,
        language: lyricSheet.language,
        nativeScriptName: lyricSheet.nativeScriptName,
        isLatinScript: lyricSheet.isLatinScript,
        lyricsNative: lyricSheet.lyricsNative,
        lyricsRoman: lyricSheet.lyricsRoman
      });
      if (!requestIsCurrent()) return;
      requestedUrl = result.url;
      shareUrl = requestedUrl;
    }
    try {
      await copyShareLink(requestedUrl);
      if (!requestIsCurrent()) return;
      setShareLabel('Copied');
      notice.className = 'notice working';
      notice.textContent = 'Share link copied. The mehfil can travel now.';
    } catch {
      if (!requestIsCurrent()) return;
      setShareLabel('Link ready');
      notice.className = 'notice working';
      notice.textContent = `Share link: ${requestedUrl}`;
    }
  } catch (error) {
    if (!requestIsCurrent()) return;
    setShareLabel('Retry');
    notice.className = 'notice';
    notice.textContent = error.message;
  } finally {
    if (requestIsCurrent()) shareButton.disabled = false;
  }
});
