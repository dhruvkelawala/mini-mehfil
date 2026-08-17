import { createSignal, getOwner, onCleanup } from 'solid-js';

import type { HostLyrics } from './generation-recovery.ts';

const ROOM_SESSION_KEY = 'mini-mehfil-host-room';

interface RoomDetails {
  roomId: string;
  joinUrl: string;
  socketUrl: string;
  hostSecret: string;
  expiresAt: number;
}

export interface HostRoomController {
  status: () => string;
  details: () => RoomDetails | null;
  open(): Promise<void>;
  publishSong(shareId: string, lyrics: HostLyrics): void;
  close(): void;
}

export type RoomFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDetails(value: unknown): RoomDetails | null {
  if (
    !isRecord(value) ||
    typeof value.roomId !== 'string' ||
    typeof value.joinUrl !== 'string' ||
    typeof value.socketUrl !== 'string' ||
    typeof value.hostSecret !== 'string' ||
    typeof value.expiresAt !== 'number'
  )
    return null;
  return {
    roomId: value.roomId,
    joinUrl: value.joinUrl,
    socketUrl: value.socketUrl,
    hostSecret: value.hostSecret,
    expiresAt: value.expiresAt,
  };
}

export function createHostRoomController({
  fetcher = (input, init) => fetch(input, init),
  storage = sessionStorage,
  socketFactory = (url) => new WebSocket(url),
}: {
  fetcher?: RoomFetch;
  storage?: Storage;
  socketFactory?: (url: string) => WebSocket;
} = {}): HostRoomController {
  const [status, setStatus] = createSignal('private');
  const [details, setDetails] = createSignal<RoomDetails | null>(null);
  let socket: WebSocket | null = null;

  const connect = (room: RoomDetails) => {
    socket?.close();
    setStatus('connecting');
    const next = socketFactory(room.socketUrl);
    socket = next;
    next.addEventListener('open', () => {
      next.send(JSON.stringify({ type: 'auth-host', secret: room.hostSecret }));
    });
    next.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return;
      let message: unknown;
      try {
        message = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      if (isRecord(message) && message.type === 'snapshot')
        setStatus('connected');
      if (isRecord(message) && message.type === 'error') {
        setStatus(
          typeof message.code === 'string' ? message.code : 'room error',
        );
      }
    });
    next.addEventListener('close', () => {
      if (next === socket && details()) setStatus('offline');
    });
  };

  const close = () => {
    socket?.close();
    socket = null;
  };
  if (getOwner()) onCleanup(close);

  const saved = parseDetails(
    JSON.parse(storage.getItem(ROOM_SESSION_KEY) ?? 'null') as unknown,
  );
  if (saved && saved.expiresAt > Date.now()) {
    setDetails(saved);
    connect(saved);
  }

  return {
    status,
    details,
    async open() {
      setStatus('opening');
      const response = await fetcher('/api/rooms', { method: 'POST' });
      const value: unknown = await response.json();
      const room = parseDetails(value);
      if (!response.ok || !room)
        throw new Error('The room could not be opened.');
      storage.setItem(ROOM_SESSION_KEY, JSON.stringify(room));
      setDetails(room);
      connect(room);
    },
    publishSong(shareId, lyrics) {
      if (socket?.readyState !== 1) return;
      socket.send(
        JSON.stringify({
          type: 'song-ready',
          shareId,
          title: lyrics.title,
          language: lyrics.language,
          lyrics,
          startedAt: Date.now(),
        }),
      );
    },
    close,
  };
}
