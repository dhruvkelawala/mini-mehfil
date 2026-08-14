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
let shareReference = null;
let shareUrl = null;

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
  lyricSheet = null;
  hasRevealed = false;
  peek.hidden = true;
  lyricReveal.hidden = true;
  revealLines.textContent = '';
  peekToggle.setAttribute('aria-expanded', 'false');
  peekToggle.querySelector('strong').textContent = 'Reveal lyrics';
  peekToggle.querySelector('small').textContent = "Wanna be surprised? Don't click me.";
}

// Lines arrive one at a time, like someone writing them in front of you.
function typeOut(text) {
  const lines = text.split('\n');
  let index = 0;
  revealLines.textContent = '';
  const tick = () => {
    revealLines.textContent += (index ? '\n' : '') + lines[index];
    revealLines.scrollTop = revealLines.scrollHeight;
    index += 1;
    if (index < lines.length) setTimeout(tick, 55);
  };
  tick();
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
  revealLanguage.textContent = lyricSheet.isLatinScript
    ? lyricSheet.language
    : `${lyricSheet.language} · ${lyricSheet.nativeScriptName}`;
  // Type them out the first time; after that just show them instantly.
  if (hasRevealed) revealLines.textContent = lyricSheet.lyricsRoman;
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
  waitingTimer = setInterval(() => {
    index = Math.min(index + 1, lines.length - 1);
    notice.textContent = lines[index];
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

function loadSong(source, title, reference) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  const isUrl = /^https?:\/\//i.test(source);
  objectUrl = isUrl ? null : decodeHexAudio(source);
  audio.src = isUrl ? source : objectUrl;
  trackTitle.textContent = title || 'Your Mehfil recording';
  trackSubtitle.textContent = 'Fresh from MiniMax Music 3';
  shareReference = reference || null;
  shareUrl = null;
  shareButton.disabled = !shareReference;
  shareButton.innerHTML = '↗<span>Share</span>';
  playButton.disabled = false;
  download.href = audio.src;
  download.setAttribute('aria-disabled', 'false');
  audio.play().catch(() => {});
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  notice.textContent = '';
  if (!form.reportValidity()) return;
  resetPeek();
  shareReference = null;
  shareUrl = null;
  shareButton.disabled = true;
  shareButton.innerHTML = '↗<span>Share</span>';

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
    scene.classList.add('is-performing');

    // The native script is what gets sung: the music model pronounces it best.
    const result = await post('/api/generate', {
      token: tokenInput.value,
      prompt: lyricSheet.prompt || vibeInput.value,
      lyrics: lyricSheet.lyricsNative || lyricSheet.lyricsRoman
    });
    const source = result?.data?.audio || result?.audio?.url || result?.audio;
    if (!source || typeof source !== 'string') throw new Error('MiniMax succeeded but did not return an audio file.');

    loadSong(source, lyricSheet.title, result.share_ref);
    notice.className = 'notice working';
    notice.textContent = 'Your recording is ready.';
  } catch (error) {
    notice.className = 'notice';
    notice.textContent = error.message;
  } finally {
    scene.classList.remove('is-performing');
    setBusy(false, []);
  }
});

playButton.addEventListener('click', () => {
  if (audio.paused) audio.play(); else audio.pause();
});
audio.addEventListener('play', () => {
  player.classList.add('playing');
  scene.classList.add('is-performing');
  playButton.querySelector('span').textContent = '❚❚';
  playButton.setAttribute('aria-label', 'Pause');
});
audio.addEventListener('pause', () => {
  player.classList.remove('playing');
  scene.classList.remove('is-performing');
  playButton.querySelector('span').textContent = '▶';
  playButton.setAttribute('aria-label', 'Play');
});
audio.addEventListener('timeupdate', () => {
  seek.value = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  timecode.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
});
audio.addEventListener('loadedmetadata', () => {
  timecode.textContent = `0:00 / ${formatTime(audio.duration)}`;
});
seek.addEventListener('input', () => {
  if (audio.duration) audio.currentTime = (Number(seek.value) / 100) * audio.duration;
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
  shareButton.disabled = true;
  shareButton.innerHTML = '…<span>Sharing</span>';
  try {
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
      shareUrl = result.url;
    }
    try {
      await copyShareLink(shareUrl);
      shareButton.innerHTML = '✓<span>Copied</span>';
      notice.className = 'notice working';
      notice.textContent = 'Share link copied. The mehfil can travel now.';
    } catch {
      shareButton.innerHTML = '↗<span>Link ready</span>';
      notice.className = 'notice working';
      notice.textContent = `Share link: ${shareUrl}`;
    }
  } catch (error) {
    shareButton.innerHTML = '↻<span>Retry</span>';
    notice.className = 'notice';
    notice.textContent = error.message;
  } finally {
    shareButton.disabled = false;
  }
});
