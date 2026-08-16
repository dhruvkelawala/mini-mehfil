/**
 * Browser implementation for a listener in a live room. roomPage serializes
 * this function into its nonce-protected script, so keep all dependencies
 * inside the function and pass configuration through the single argument.
 */
export function installRoomClient({ roomId }) {
  const credentialKey = `mini-mehfil-room:${roomId}`;
  const status = document.querySelector('#status');
  const joinForm = document.querySelector('#join-panel');
  const joinPanel = document.querySelector('#join-panel');
  const joinButton = document.querySelector('#join');
  const joinLabel = document.querySelector('#join-label');
  const room = document.querySelector('#room');
  const queue = document.querySelector('#queue');
  const player = document.querySelector('#player');
  const audio = document.querySelector('#audio');
  const seekProgress = document.querySelector('#listener-seek');
  const timecode = document.querySelector('#timecode');
  const enableAudio = document.querySelector('#enable-audio');
  const playError = document.querySelector('#play-error');
  const playbackState = document.querySelector('#playback-state');
  const identity = document.querySelector('.identity');
  const lyricStage = document.querySelector('#lyric-stage');
  const lyricTitle = document.querySelector('#lyric-title');
  const lyricCue = document.querySelector('#lyric-cue');
  const lyricPrimary = document.querySelector('#lyric-primary');
  const lyricSecondary = document.querySelector('#lyric-secondary');
  const scene = document.querySelector('.scene');

  let socket;
  let retryCount = 0;
  let terminal = false;
  let lastShareId = null;
  let songLines = [];
  let currentSong = null;
  let playbackTimer = null;
  let playbackRevision = null;
  let lastLyricIndex = -1;
  let silentAudioUrl = null;

  function setJoinBusy(busy) {
    joinButton.disabled = busy;
    joinButton.classList[busy ? 'add' : 'remove']('is-loading');
    joinButton.setAttribute('aria-busy', String(busy));
    joinLabel.textContent = busy ? 'Taking your seat…' : 'Join the mehfil';
  }

  function webSocketUrl() {
    return location.origin.replace(/^http/, 'ws') + `/rooms/${roomId}/ws`;
  }

  function stopRoom(message, {
    clearCredential = true,
    allowFreshJoin = false
  } = {}) {
    terminal = true;
    setJoinBusy(false);
    if (clearCredential) sessionStorage.removeItem(credentialKey);
    status.textContent = message;
    socket?.close();
    if (allowFreshJoin) {
      joinPanel.hidden = false;
      room.hidden = true;
    }
  }

  function handleRoomError(code) {
    if (code === 'resume-invalid') {
      stopRoom('Your seat expired. Join again.', { allowFreshJoin: true });
      return;
    }
    if (code === 'room-full') {
      stopRoom('This mehfil is full.');
      return;
    }
    if (code === 'kicked') {
      stopRoom('You were asked to leave the mehfil.');
      return;
    }
    if (code === 'room-expired' || code === 'room-unavailable') {
      stopRoom('This mehfil has ended.');
      return;
    }
    status.textContent = code;
  }

  function reconnect(name) {
    status.textContent = 'Offline — reconnecting…';
    const delay = Math.min(1_000 * 2 ** retryCount, 30_000);
    setTimeout(() => {
      if (terminal) return;
      retryCount = Math.min(retryCount + 1, 6);
      connect(name);
    }, delay);
  }

  function connect(name) {
    terminal = false;
    setJoinBusy(true);
    status.textContent = retryCount ? 'Reconnecting…' : 'Joining…';
    socket = new WebSocket(webSocketUrl());

    socket.addEventListener('open', () => {
      const resume = sessionStorage.getItem(credentialKey);
      socket.send(JSON.stringify(resume
        ? { type: 'join', resume }
        : { type: 'join', name }));
      retryCount = 0;
    });

    socket.addEventListener('message', event => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        stopRoom('The room sent a malformed message.', { clearCredential: false });
        return;
      }

      if (message.type === 'resume-credential') {
        sessionStorage.setItem(credentialKey, message.credential);
      }
      if (message.type === 'snapshot') render(message.state);
      if (message.type === 'error') handleRoomError(message.code);
    });

    socket.addEventListener('close', event => {
      if (terminal) return;
      if (event.code === 4002) {
        stopRoom('This mehfil is full.');
        return;
      }
      if (event.code === 4003) {
        stopRoom('You were asked to leave the mehfil.');
        return;
      }
      if (event.code === 4004) {
        stopRoom('This mehfil has ended.');
        return;
      }
      if (event.code === 4001) {
        stopRoom('This room is unavailable.', { allowFreshJoin: true });
        return;
      }
      reconnect(name);
    });
  }

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  async function attemptRoomPlayback() {
    playError.textContent = '';
    if (audio.ended) audio.currentTime = 0;
    try {
      await audio.play();
      enableAudio.hidden = true;
      return true;
    } catch {
      enableAudio.hidden = false;
      playError.textContent = 'Your browser blocked shared audio. Enable sound once to join the music.';
      return false;
    }
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  }

  function syncPlayerTimeline() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const progress = duration ? Math.min(100, (currentTime / duration) * 100) : 0;
    seekProgress.value = progress;
    timecode.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  }

  function setPlaybackState(isPlaying, label = isPlaying ? 'Playing with the host' : 'Host paused') {
    player.classList[isPlaying ? 'add' : 'remove']('is-playing');
    playbackState.textContent = label;
  }

  function prepareAudioUnlock() {
    if (silentAudioUrl) URL.revokeObjectURL(silentAudioUrl);
    const wavHeader = new Uint8Array([
      82, 73, 70, 70, 244, 7, 0, 0, 87, 65, 86, 69,
      102, 109, 116, 32, 16, 0, 0, 0, 1, 0, 1, 0,
      64, 31, 0, 0, 128, 62, 0, 0, 2, 0, 16, 0,
      100, 97, 116, 97, 208, 7, 0, 0
    ]);
    silentAudioUrl = URL.createObjectURL(new Blob([
      wavHeader,
      new Uint8Array(2_000)
    ], { type: 'audio/wav' }));
    audio.src = silentAudioUrl;
    audio.load();
  }

  function prepareSongLyrics(song) {
    const sheet = song.lyrics || {};
    const native = (sheet.lyricsNative || '').split('\n').filter(line => line.trim());
    const roman = (sheet.lyricsRoman || '').split('\n').filter(line => line.trim());
    const useNative = !sheet.isLatinScript && native.length;
    const primary = useNative ? native : roman;

    songLines = primary.map((line, index) => {
      const romanLine = roman[index] || '';
      const cue = /^\[.+\]$/.test(romanLine || line);
      return {
        cue,
        primary: cue ? (romanLine || line) : line,
        secondary: useNative && !cue && romanLine !== line ? romanLine : ''
      };
    });

    lyricTitle.textContent = song.title || 'Now playing';
    document.querySelector('#song-language').textContent = sheet.language
      || song.language
      || '';
    lyricStage.hidden = false;
    identity.classList.add('has-song');
    lastLyricIndex = -1;
    syncSongLyrics();
  }

  function syncSongLyrics() {
    const spokenLines = songLines
      .map((line, index) => ({ ...line, index }))
      .filter(line => !line.cue);
    if (!spokenLines.length) {
      lyricStage.hidden = true;
      return;
    }
    const progress = audio.duration
      ? Math.min(audio.currentTime / (audio.duration * 0.9), 1)
      : 0;
    const spokenIndex = Math.min(
      spokenLines.length - 1,
      Math.floor(progress * spokenLines.length)
    );
    const active = spokenLines[spokenIndex];
    if (active.index === lastLyricIndex) return;
    lastLyricIndex = active.index;
    const cue = songLines.slice(0, active.index).findLast(line => line.cue);
    lyricCue.textContent = cue?.primary.replace(/^\[(.+)\]$/, '$1') || '';
    lyricPrimary.textContent = active.primary;
    lyricSecondary.textContent = active.secondary;
    lyricPrimary.classList.remove('is-new');
    lyricSecondary.classList.remove('is-new');
    requestAnimationFrame(() => {
      lyricPrimary.classList.add('is-new');
      lyricSecondary.classList.add('is-new');
    });
  }

  function roomPlaybackPositionMs(playback) {
    const elapsed = playback.status === 'playing'
      ? Math.max(0, Date.now() - playback.changedAt)
      : 0;
    return Math.max(0, playback.positionMs + elapsed);
  }

  function applyRoomPlayback(song) {
    currentSong = song;
    const playback = song.playback || {
      status: 'paused',
      positionMs: 0,
      changedAt: song.startedAt
    };
    const revision = `${song.shareId}:${playback.status}:${playback.positionMs}:${playback.changedAt}`;
    if (revision === playbackRevision) return;
    clearTimeout(playbackTimer);
    playbackTimer = null;
    playbackRevision = revision;
    const apply = async () => {
      const desired = roomPlaybackPositionMs(playback) / 1000;
      audio.currentTime = Number.isFinite(audio.duration)
        ? Math.min(desired, audio.duration)
        : desired;
      syncPlayerTimeline();
      syncSongLyrics();
      if (playback.status === 'playing') await attemptRoomPlayback();
      else {
        audio.pause();
        setPlaybackState(false);
      }
    };
    if (audio.readyState < 1) {
      audio.addEventListener('loadedmetadata', () => {
        playbackRevision = null;
        applyRoomPlayback(song);
      }, { once: true });
      return;
    }
    if (playback.status === 'playing' && playback.changedAt > Date.now()) {
      audio.pause();
      audio.currentTime = playback.positionMs / 1000;
      setPlaybackState(false, 'Starting together…');
      playbackTimer = setTimeout(apply, playback.changedAt - Date.now());
    } else {
      void apply();
    }
  }

  function renderQueue(state) {
    queue.replaceChildren(...state.queue.map(item => {
      const row = document.createElement('li');
      row.textContent = `${item.mine ? 'Your request' : 'A request'} — ${item.status}`;
      return row;
    }));

    const recording = state.currentRecording;
    const recordingRequest = recording
      ? state.queue.find(item => item.id === recording.requestId)
      : null;
    document.querySelector('#recording').textContent = recording
      ? (recordingRequest?.mine ? 'The band is recording yours' : 'The band is recording')
      : '';

    const peek = document.querySelector('#peek');
    const lyrics = document.querySelector('#lyrics');
    peek.hidden = !recording?.lyrics;
    if (recording?.lyrics) {
      lyrics.textContent = `${recording.lyrics.lyricsNative || ''}\n\n${recording.lyrics.lyricsRoman || ''}`;
    }
  }

  function renderSong(song) {
    if (!song) return;
    player.hidden = false;
    document.querySelector('#song-title').textContent = song.title;
    currentSong = song;
    if (song.shareId === lastShareId) {
      applyRoomPlayback(song);
      return;
    }

    lastShareId = song.shareId;
    playError.textContent = '';
    prepareSongLyrics(song);
    if (silentAudioUrl) {
      URL.revokeObjectURL(silentAudioUrl);
      silentAudioUrl = null;
    }
    audio.src = `/s/${song.shareId}/audio`;
    setPlaybackState(false);
    audio.load();
    applyRoomPlayback(song);
  }

  function renderSetlist(setlist) {
    document.querySelector('#setlist').replaceChildren(...setlist.map(item => {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = `/s/${item.shareId}`;
      link.textContent = item.title;
      row.append(link);
      return row;
    }));
  }

  function render(state) {
    setJoinBusy(false);
    joinPanel.hidden = true;
    room.hidden = false;
    status.textContent = state.hostPresent
      ? 'The host is here.'
      : 'Host away — requests will wait.';
    document.querySelector('#listeners').textContent = `${state.listenerCount} listener${state.listenerCount === 1 ? '' : 's'}`;
    document.querySelector('#host').textContent = state.hostPresent
      ? 'Host present'
      : 'Host away';
    renderQueue(state);
    renderSong(state.currentSong);
    renderSetlist(state.setlist);
  }

  joinForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (joinButton.disabled) return;
    terminal = false;
    setJoinBusy(true);
    prepareAudioUnlock();
    try {
      audio.muted = true;
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
    } catch {
      enableAudio.hidden = false;
      playError.textContent = 'Your browser needs sound enabled once.';
    } finally {
      audio.muted = false;
    }
    connect(document.querySelector('#name').value);
  });

  document.querySelector('#request').addEventListener('submit', event => {
    event.preventDefault();
    send({
      type: 'request-submitted',
      idea: document.querySelector('#idea').value,
      vibe: document.querySelector('#vibe').value,
      language: document.querySelector('#language').value
    });
    event.target.reset();
  });

  document.querySelector('#peek').addEventListener('click', () => {
    document.querySelector('#lyrics').hidden = false;
  });
  enableAudio.addEventListener('click', () => {
    if (currentSong) applyRoomPlayback(currentSong);
  });
  audio.addEventListener('play', () => {
    scene.classList.add('is-performing');
    setPlaybackState(true);
    syncSongLyrics();
  });
  audio.addEventListener('pause', () => {
    scene.classList.remove('is-performing');
    setPlaybackState(false);
  });
  audio.addEventListener('ended', () => {
    scene.classList.remove('is-performing');
    setPlaybackState(false, 'Song finished');
  });
  audio.addEventListener('durationchange', syncPlayerTimeline);
  audio.addEventListener('timeupdate', () => {
    syncPlayerTimeline();
    syncSongLyrics();
  });

  if (sessionStorage.getItem(credentialKey)) connect('');
}
