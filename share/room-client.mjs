/**
 * Browser implementation for a listener in a live room. roomPage serializes
 * this function into its nonce-protected script, so keep all dependencies
 * inside the function and pass configuration through the single argument.
 */
export function installRoomClient({ roomId }) {
  const credentialKey = `mini-mehfil-room:${roomId}`;
  const status = document.querySelector('#status');
  const joinPanel = document.querySelector('#join-panel');
  const room = document.querySelector('#room');
  const queue = document.querySelector('#queue');
  const audio = document.querySelector('#audio');
  const play = document.querySelector('#play');
  const playError = document.querySelector('#play-error');
  const songLyrics = document.querySelector('#song-lyrics');
  const scene = document.querySelector('.scene');

  let socket;
  let retryCount = 0;
  let terminal = false;
  let lastShareId = null;
  let songLines = [];
  let silentAudioUrl = null;

  function webSocketUrl() {
    return location.origin.replace(/^http/, 'ws') + `/rooms/${roomId}/ws`;
  }

  function stopRoom(message, {
    clearCredential = true,
    allowFreshJoin = false
  } = {}) {
    terminal = true;
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
    play.hidden = false;
    playError.textContent = '';
    try {
      await audio.play();
      play.hidden = true;
      return true;
    } catch {
      play.hidden = false;
      playError.textContent = 'Playback needs another tap. Please try again.';
      return false;
    }
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

    songLyrics.replaceChildren(...songLines.map(value => {
      const line = document.createElement('span');
      line.className = value.cue ? 'song-line cue' : 'song-line';
      line.textContent = value.cue
        ? value.primary.replace(/^\[(.+)\]$/, '$1')
        : value.primary;
      if (value.secondary) {
        const secondary = document.createElement('small');
        secondary.textContent = value.secondary;
        line.append(secondary);
      }
      return line;
    }));

    document.querySelector('#song-language').textContent = sheet.language
      || song.language
      || '';
    syncSongLyrics();
  }

  function syncSongLyrics() {
    const spokenCount = songLines.filter(line => !line.cue).length;
    const progress = audio.duration
      ? Math.min(audio.currentTime / (audio.duration * 0.9), 1)
      : 0;
    const shownCount = Math.min(spokenCount, Math.ceil(progress * spokenCount));
    let seenCount = 0;

    [...songLyrics.children].forEach((element, index) => {
      if (songLines[index].cue) {
        element.hidden = shownCount <= seenCount;
      } else {
        seenCount += 1;
        element.hidden = seenCount > shownCount;
      }
    });
    songLyrics.scrollTop = songLyrics.scrollHeight;
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
    document.querySelector('#player').hidden = false;
    document.querySelector('#song-title').textContent = song.title;
    if (song.shareId === lastShareId) return;

    lastShareId = song.shareId;
    play.hidden = false;
    playError.textContent = 'Tap to hear this recording.';
    prepareSongLyrics(song);
    if (silentAudioUrl) {
      URL.revokeObjectURL(silentAudioUrl);
      silentAudioUrl = null;
    }
    audio.src = `/s/${song.shareId}/audio`;
    audio.load();
    audio.addEventListener('loadedmetadata', async () => {
      audio.currentTime = Math.max(0, (Date.now() - song.startedAt) / 1_000);
      syncSongLyrics();
      await attemptRoomPlayback();
    }, { once: true });
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

  document.querySelector('#join').addEventListener('click', async () => {
    terminal = false;
    play.hidden = false;
    prepareAudioUnlock();
    try {
      audio.muted = true;
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
    } catch {
      play.hidden = false;
      playError.textContent = 'Playback needs another tap. Please try again.';
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
  play.addEventListener('click', () => void attemptRoomPlayback());
  audio.addEventListener('play', () => {
    scene.classList.add('is-performing');
    syncSongLyrics();
  });
  audio.addEventListener('pause', () => scene.classList.remove('is-performing'));
  audio.addEventListener('timeupdate', syncSongLyrics);

  if (sessionStorage.getItem(credentialKey)) connect('');
}
