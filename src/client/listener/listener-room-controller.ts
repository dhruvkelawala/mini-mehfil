import { createSignal, getOwner, onCleanup } from 'solid-js';

import { isRecord, parseLyricsSheet } from '../../room/protocol.ts';
import type { LyricsSheet, RoomPlayback } from '../../room/protocol.ts';

export interface ListenerSong {
  shareId: string;
  title: string;
  language: string;
  lyrics: LyricsSheet;
  playback: RoomPlayback;
}

export interface ListenerSnapshot {
  hostPresent: boolean;
  listenerCount: number;
  queue: Array<{ id: string; status: string; mine: boolean }>;
  currentRecording: {
    requestId: string;
    startedAt: number;
  } | null;
  currentSong: ListenerSong | null;
  setlist: Array<{ shareId: string; title: string }>;
}

export interface ListenerRoomController {
  status: () => string;
  joined: () => boolean;
  terminal: () => boolean;
  snapshot: () => ListenerSnapshot | null;
  audioBlocked: () => boolean;
  playbackLabel: () => string;
  bindAudio(element: HTMLAudioElement): void;
  enableAudio(): Promise<void>;
  connect(name: string): void;
  submitRequest(input: { idea: string; vibe: string; language: string }): void;
  close(): void;
}

function parseSong(value: unknown): ListenerSong | null {
  if (!isRecord(value)) return null;
  const title = typeof value.title === 'string' ? value.title : '';
  const language = typeof value.language === 'string' ? value.language : '';
  const lyrics = parseLyricsSheet(value.lyrics, { title, language });
  const playback = value.playback;
  if (
    typeof value.shareId !== 'string' ||
    !title ||
    !language ||
    !lyrics ||
    !isRecord(playback) ||
    (playback.status !== 'playing' && playback.status !== 'paused') ||
    typeof playback.positionMs !== 'number' ||
    typeof playback.changedAt !== 'number'
  ) {
    return null;
  }
  return {
    shareId: value.shareId,
    title,
    language,
    lyrics,
    playback: {
      status: playback.status,
      positionMs: playback.positionMs,
      changedAt: playback.changedAt,
    },
  };
}

function parseSnapshot(value: unknown): ListenerSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value.hostPresent !== 'boolean' ||
    typeof value.listenerCount !== 'number' ||
    !Array.isArray(value.queue) ||
    !Array.isArray(value.setlist)
  ) {
    return null;
  }
  const queue: ListenerSnapshot['queue'] = [];
  for (const item of value.queue) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.status !== 'string' ||
      typeof item.mine !== 'boolean'
    ) {
      return null;
    }
    queue.push({ id: item.id, status: item.status, mine: item.mine });
  }
  const setlist: ListenerSnapshot['setlist'] = [];
  for (const item of value.setlist) {
    if (
      !isRecord(item) ||
      typeof item.shareId !== 'string' ||
      typeof item.title !== 'string'
    ) {
      return null;
    }
    setlist.push({ shareId: item.shareId, title: item.title });
  }
  const currentSong =
    value.currentSong === null ? null : parseSong(value.currentSong);
  if (value.currentSong !== null && !currentSong) return null;
  let currentRecording: ListenerSnapshot['currentRecording'] = null;
  if (value.currentRecording !== null) {
    if (
      !isRecord(value.currentRecording) ||
      typeof value.currentRecording.requestId !== 'string' ||
      typeof value.currentRecording.startedAt !== 'number'
    ) {
      return null;
    }
    currentRecording = {
      requestId: value.currentRecording.requestId,
      startedAt: value.currentRecording.startedAt,
    };
  }
  return {
    hostPresent: value.hostPresent,
    listenerCount: value.listenerCount,
    queue,
    currentRecording,
    currentSong,
    setlist,
  };
}

const terminalMessage: Record<string, string> = {
  'room-full': 'This mehfil is full.',
  kicked: 'You were asked to leave the mehfil.',
  'room-expired': 'This mehfil has ended.',
  'room-unavailable': 'This room is unavailable.',
};

export function createListenerRoomController({
  roomId,
  socketFactory = (url) => new WebSocket(url),
  storage = sessionStorage,
}: {
  roomId: string;
  socketFactory?: (url: string) => WebSocket;
  storage?: Storage;
}): ListenerRoomController {
  const credentialKey = `mini-mehfil-room:${roomId}`;
  const [status, setStatus] = createSignal('Take a seat in the courtyard.');
  const [joined, setJoined] = createSignal(false);
  const [terminal, setTerminal] = createSignal(false);
  const [snapshot, setSnapshot] = createSignal<ListenerSnapshot | null>(null);
  const [audioBlocked, setAudioBlocked] = createSignal(false);
  const [playbackLabel, setPlaybackLabel] = createSignal(
    'Waiting for the host',
  );
  let socket: WebSocket | null = null;
  let audio: HTMLAudioElement | null = null;
  let lastShareId: string | null = null;
  let playbackRevision: string | null = null;
  let playbackTimer: ReturnType<typeof setTimeout> | undefined;
  let metadataHandler: (() => void) | null = null;
  let retryCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let lastName = '';

  const stop = (
    code: string,
    { allowFreshJoin = false, clearCredential = true } = {},
  ) => {
    setTerminal(true);
    setStatus(terminalMessage[code] ?? code);
    if (clearCredential) storage.removeItem(credentialKey);
    if (allowFreshJoin) setJoined(false);
    socket?.close();
  };

  const attemptPlayback = async () => {
    if (!audio) return;
    try {
      await audio.play();
      setAudioBlocked(false);
      setPlaybackLabel('Playing with the host');
    } catch {
      setAudioBlocked(true);
      setPlaybackLabel('Your browser needs sound enabled once.');
    }
  };

  const applyPlayback = (song: ListenerSong | null) => {
    if (!audio || !song) return;
    const playback = song.playback;
    const revision = `${song.shareId}:${playback.status}:${playback.positionMs}:${playback.changedAt}`;
    if (revision === playbackRevision) return;
    playbackRevision = revision;
    if (playbackTimer) clearTimeout(playbackTimer);
    if (metadataHandler)
      audio.removeEventListener('loadedmetadata', metadataHandler);
    metadataHandler = null;
    if (lastShareId !== song.shareId) {
      lastShareId = song.shareId;
      audio.src = `/s/${song.shareId}/audio`;
      audio.load();
    }
    const apply = () => {
      if (!audio || revision !== playbackRevision) return;
      metadataHandler = null;
      const elapsed =
        playback.status === 'playing'
          ? Math.max(0, Date.now() - playback.changedAt)
          : 0;
      const desired = (playback.positionMs + elapsed) / 1_000;
      audio.currentTime = Number.isFinite(audio.duration)
        ? Math.min(desired, audio.duration)
        : desired;
      if (playback.status === 'playing') void attemptPlayback();
      else {
        audio.pause();
        setPlaybackLabel('Host paused');
      }
    };
    if (playback.status === 'playing' && playback.changedAt > Date.now()) {
      audio.pause();
      audio.currentTime = playback.positionMs / 1_000;
      setPlaybackLabel('Starting together…');
      playbackTimer = setTimeout(apply, playback.changedAt - Date.now());
    } else if (audio.readyState < 1) {
      metadataHandler = apply;
      audio.addEventListener('loadedmetadata', apply, { once: true });
    } else apply();
  };

  const connect = (name: string) => {
    lastName = name;
    setTerminal(false);
    setStatus(retryCount ? 'Reconnecting…' : 'Joining…');
    const next = socketFactory(
      `${location.origin.replace(/^http/, 'ws')}/rooms/${roomId}/ws`,
    );
    socket = next;
    next.addEventListener('open', () => {
      const resume = storage.getItem(credentialKey);
      next.send(
        JSON.stringify(
          resume ? { type: 'join', resume } : { type: 'join', name },
        ),
      );
      retryCount = 0;
    });
    next.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') {
        stop('The room sent a malformed message.', { clearCredential: false });
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(event.data) as unknown;
      } catch {
        stop('The room sent a malformed message.', { clearCredential: false });
        return;
      }
      if (!isRecord(message) || typeof message.type !== 'string') return;
      if (
        message.type === 'resume-credential' &&
        typeof message.credential === 'string'
      ) {
        storage.setItem(credentialKey, message.credential);
      } else if (message.type === 'snapshot') {
        const parsed = parseSnapshot(message.state);
        if (!parsed) {
          stop('The room sent a malformed message.', {
            clearCredential: false,
          });
          return;
        }
        setSnapshot(parsed);
        applyPlayback(parsed.currentSong);
        setJoined(true);
        setStatus(
          parsed.hostPresent
            ? 'The host is here.'
            : 'Host away — requests will wait.',
        );
      } else if (message.type === 'error' && typeof message.code === 'string') {
        if (message.code === 'resume-invalid') {
          stop('Your seat expired. Join again.', { allowFreshJoin: true });
        } else if (message.code in terminalMessage) stop(message.code);
        else setStatus(message.code);
      }
    });
    next.addEventListener('close', (event: CloseEvent) => {
      if (terminal() || next !== socket) return;
      if (event.code === 4001) {
        stop('room-unavailable', { allowFreshJoin: true });
        return;
      }
      if (event.code === 4002) return stop('room-full');
      if (event.code === 4003) return stop('kicked');
      if (event.code === 4004) return stop('room-expired');
      setStatus('Offline — reconnecting…');
      const delay = Math.min(1_000 * 2 ** retryCount, 30_000);
      retryCount = Math.min(retryCount + 1, 6);
      reconnectTimer = setTimeout(() => connect(lastName), delay);
    });
  };

  const submitRequest = (input: {
    idea: string;
    vibe: string;
    language: string;
  }) => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'request-submitted', ...input }));
  };

  const close = () => {
    setTerminal(true);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (playbackTimer) clearTimeout(playbackTimer);
    if (audio && metadataHandler)
      audio.removeEventListener('loadedmetadata', metadataHandler);
    metadataHandler = null;
    socket?.close();
  };
  if (getOwner()) onCleanup(close);

  const bindAudio = (element: HTMLAudioElement) => {
    audio = element;
    audio.addEventListener('play', () =>
      setPlaybackLabel('Playing with the host'),
    );
    audio.addEventListener('pause', () => {
      if (!audio?.ended) setPlaybackLabel('Host paused');
    });
    audio.addEventListener('ended', () => setPlaybackLabel('Song finished'));
    applyPlayback(snapshot()?.currentSong ?? null);
  };

  const enableAudio = async () => {
    playbackRevision = null;
    applyPlayback(snapshot()?.currentSong ?? null);
    await attemptPlayback();
  };

  if (storage.getItem(credentialKey)) connect('');
  return {
    status,
    joined,
    terminal,
    snapshot,
    audioBlocked,
    playbackLabel,
    bindAudio,
    enableAudio,
    connect,
    submitRequest,
    close,
  };
}
