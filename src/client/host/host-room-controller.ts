import { createMemo, createSignal, getOwner, onCleanup } from 'solid-js';

import { isRoomId } from '../../room/primitives.ts';
import {
  isRecord,
  parseHostRoomProjection,
  type ClientMessage,
  type LyricsSheet,
  type Participant,
  type RoomSong,
  type HostRoomProjection,
  type RoomState,
  type SetlistSong,
  type SongRequest,
} from '../../room/protocol.ts';

export const ROOM_SESSION_KEY = 'mini-mehfil-host-room';
const SHARE_ID = /^[A-Za-z0-9_-]{16}$/;

export interface RoomDetails {
  roomId: string;
  joinUrl: string;
  socketUrl: string;
  hostSecret: string;
  expiresAt: number;
}
export interface QueueItem extends SongRequest {
  requesterName: string;
}
export interface SetlistItem extends SetlistSong {
  url: string;
}
export interface HostRoomView {
  participants: Array<Pick<Participant, 'id' | 'name'>>;
  queue: QueueItem[];
  setlist: SetlistItem[];
}
export interface RoomRecordingAdapters<T> {
  requestId: string;
  run: number;
  isCurrent: (run: number) => boolean;
  generate: (hooks: {
    onLyrics: (sheet: LyricsSheet) => void;
    onReady: (generated: T) => void;
    onFailed: () => void;
  }) => Promise<T | undefined>;
  upload: (generated: T) => Promise<string | undefined>;
  send: (message: ClientMessage) => boolean;
}

export interface HostRoomController {
  status: () => string;
  message: () => string;
  details: () => RoomDetails | null;
  snapshot: () => HostRoomProjection | null;
  view: () => HostRoomView;
  listenerCount: () => number;
  authenticated: () => boolean;
  terminal: () => boolean;
  panelOpen: () => boolean;
  opening: () => boolean;
  closing: () => boolean;
  currentSong: () => RoomSong | null;
  open(): Promise<void>;
  showPanel(open: boolean): void;
  send(message: ClientMessage): boolean;
  publishStandalone(shareUrl: string, lyrics: LyricsSheet): boolean;
  accept(requestId: string): boolean;
  reorder(requestId: string, toIndex: number): boolean;
  decline(requestId: string): boolean;
  kick(participantId: string): boolean;
  closeRoom(): void;
  abandon(): void;
}

export type RoomFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
function parseDetails(value: unknown): RoomDetails | null {
  if (
    !isRecord(value) ||
    !isRoomId(value.roomId) ||
    typeof value.joinUrl !== 'string' ||
    typeof value.socketUrl !== 'string' ||
    typeof value.hostSecret !== 'string' ||
    value.hostSecret.length < 32 ||
    typeof value.expiresAt !== 'number'
  )
    return null;
  try {
    const join = new URL(value.joinUrl);
    const socket = new URL(value.socketUrl);
    if (
      join.protocol !== 'https:' ||
      socket.protocol !== 'wss:' ||
      join.origin !== `https://${socket.host}` ||
      !join.pathname.endsWith(`/r/${value.roomId}`) ||
      !socket.pathname.endsWith(`/rooms/${value.roomId}/ws`)
    )
      return null;
  } catch {
    return null;
  }
  return {
    roomId: value.roomId,
    joinUrl: value.joinUrl,
    socketUrl: value.socketUrl,
    hostSecret: value.hostSecret,
    expiresAt: value.expiresAt,
  };
}
export function roomReorderTargets(
  queue: SongRequest[],
  itemId: string,
): { up: number; down: number } {
  const movable = queue.filter(
    (item) => item.status !== 'declined' && item.status !== 'ready',
  );
  const position = movable.findIndex((item) => item.id === itemId);
  const fullIndex = queue.findIndex((item) => item.id === itemId);
  return {
    up:
      position > 0
        ? queue.findIndex((item) => item.id === movable[position - 1]?.id)
        : fullIndex,
    down:
      position >= 0 && position < movable.length - 1
        ? queue.findIndex((item) => item.id === movable[position + 1]?.id)
        : fullIndex,
  };
}
export function hostRoomView(
  state: HostRoomProjection | RoomState | null,
  joinUrl: string,
): HostRoomView {
  if (!state) return { participants: [], queue: [], setlist: [] };
  const origin = new URL(joinUrl).origin;
  const names = new Map(
    state.participants.map((participant) => [
      participant.id,
      participant.name || 'Listener',
    ]),
  );
  return {
    participants: state.participants.map((participant) => ({
      id: participant.id,
      name: participant.name || 'Listener',
    })),
    queue: state.queue.map((item) => ({
      ...item,
      requesterName: names.get(item.participantId) || 'Listener',
    })),
    setlist: state.setlist.map((item) => ({
      ...item,
      url: `${origin}/s/${item.shareId}`,
    })),
  };
}
export async function runRoomRecordingLifecycle<T>(
  adapters: RoomRecordingAdapters<T>,
): Promise<'ready' | 'failed' | 'stale' | 'disconnected'> {
  const { requestId, run, isCurrent, generate, upload, send } = adapters;
  if (!send({ type: 'recording-started', requestId })) return 'disconnected';
  return await new Promise((resolve) => {
    let completionStarted = false;
    const fail = () => {
      if (completionStarted) return;
      completionStarted = true;
      if (isCurrent(run)) send({ type: 'recording-failed', requestId });
      resolve('failed');
    };
    const complete = async (generated: T) => {
      if (completionStarted) return;
      completionStarted = true;
      if (!isCurrent(run)) return resolve('stale');
      try {
        const url = await upload(generated);
        if (!isCurrent(run)) return resolve('stale');
        if (!url)
          throw new Error('The share service returned an invalid link.');
        const match = /\/s\/([A-Za-z0-9_-]{16})$/.exec(new URL(url).pathname);
        if (!match?.[1])
          throw new Error('The share service returned an invalid link.');
        send({ type: 'song-ready', requestId, shareId: match[1] });
        resolve('ready');
      } catch {
        if (isCurrent(run)) send({ type: 'recording-failed', requestId });
        resolve('failed');
      }
    };
    void generate({
      onLyrics: (sheet) => {
        if (isCurrent(run))
          send({ type: 'lyrics-ready', requestId, lyrics: sheet });
      },
      onReady: (generated) => void complete(generated),
      onFailed: fail,
    })
      .then((generated) => {
        if (generated !== undefined) void complete(generated);
      })
      .catch(fail);
  });
}

export function createHostRoomController({
  fetcher = (input, init) => fetch(input, init),
  storage = sessionStorage,
  socketFactory = (url) => new WebSocket(url),
  now = Date.now,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
}: {
  fetcher?: RoomFetch;
  storage?: Storage;
  socketFactory?: (url: string) => WebSocket;
  now?: () => number;
  schedule?: typeof setTimeout;
  cancelSchedule?: typeof clearTimeout;
} = {}): HostRoomController {
  const [status, setStatus] = createSignal('closed');
  const [message, setMessage] = createSignal('');
  const [details, setDetails] = createSignal<RoomDetails | null>(null);
  const [snapshot, setSnapshot] = createSignal<HostRoomProjection | null>(null);
  const [authenticated, setAuthenticated] = createSignal(false);
  const [terminal, setTerminal] = createSignal(false);
  const [panelOpen, setPanelOpen] = createSignal(false);
  const [opening, setOpening] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  const view = createMemo(() =>
    hostRoomView(
      snapshot(),
      details()?.joinUrl ?? 'https://invalid.example/r/INVALID0',
    ),
  );
  const listenerCount = createMemo(
    () =>
      snapshot()?.participants.filter((participant) => participant.connected)
        .length ?? 0,
  );
  const currentSong = createMemo(() => snapshot()?.currentSong ?? null);
  let socket: WebSocket | null = null;
  let retry = 0;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (connectTimer) cancelSchedule(connectTimer);
    if (retryTimer) cancelSchedule(retryTimer);
    if (closeTimer) cancelSchedule(closeTimer);
    connectTimer = retryTimer = closeTimer = null;
  };
  const abandon = () => {
    clearTimers();
    setTerminal(true);
    setClosing(false);
    setAuthenticated(false);
    storage.removeItem(ROOM_SESSION_KEY);
    socket?.close();
    socket = null;
    setSnapshot(null);
    setDetails(null);
    setMessage('');
    setPanelOpen(false);
    setStatus('closed');
  };
  const send = (event: ClientMessage): boolean => {
    if (socket?.readyState !== WebSocket.OPEN || !authenticated()) return false;
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      setAuthenticated(false);
      setStatus('offline');
      setMessage('The live room lost its connection. Retrying…');
      return false;
    }
  };

  const connect = (room: RoomDetails) => {
    if (connectTimer) cancelSchedule(connectTimer);
    if (retryTimer) cancelSchedule(retryTimer);
    setTerminal(false);
    setAuthenticated(false);
    setDetails(room);
    setPanelOpen(true);
    setStatus(retry ? 'reconnecting' : 'connecting');
    setMessage(
      retry
        ? 'Trying to bring the room back…'
        : 'Preparing a place for your listeners…',
    );
    const next = socketFactory(room.socketUrl);
    socket = next;
    // eslint-disable-next-line solid/reactivity -- timer deliberately reads current connection state
    connectTimer = schedule(() => {
      if (next !== socket || authenticated()) return;
      setStatus('offline');
      setMessage('The live room did not answer. Retrying…');
      next.close();
    }, 8_000);
    next.addEventListener('open', () => {
      if (connectTimer) cancelSchedule(connectTimer);
      connectTimer = null;
      retry = 0;
      next.send(
        JSON.stringify({
          type: 'auth-host',
          secret: room.hostSecret,
        } satisfies ClientMessage),
      );
    });
    next.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isRecord(value) || typeof value.type !== 'string') return;
      if (value.type === 'snapshot') {
        const state = parseHostRoomProjection(value.state);
        if (!state) return;
        setAuthenticated(true);
        setMessage('');
        setSnapshot(state);
        setStatus(state.expiredAt ? 'expired' : 'connected');
        if (state.expiredAt) abandon();
      } else if (value.type === 'error' && typeof value.code === 'string') {
        setMessage(value.code);
        if (value.code === 'auth-failed' || value.code === 'room-expired')
          abandon();
      }
    });
    next.addEventListener('error', () => {
      if (next !== socket || terminal()) return;
      setStatus('offline');
      setMessage('The live room lost its connection. Retrying…');
    });
    next.addEventListener('close', (event: CloseEvent) => {
      if (connectTimer) cancelSchedule(connectTimer);
      connectTimer = null;
      if (next !== socket) return;
      setAuthenticated(false);
      if (terminal()) return;
      if (
        event.code === 4001 ||
        event.code === 4004 ||
        now() >= room.expiresAt
      ) {
        abandon();
        return;
      }
      if (closing()) return;
      setStatus('reconnecting');
      setMessage('Trying to bring the room back…');
      const delay = Math.min(1_000 * 2 ** retry, 30_000);
      retry = Math.min(retry + 1, 6);
      // eslint-disable-next-line solid/reactivity -- retry deliberately reads terminal state at execution
      retryTimer = schedule(() => {
        if (!terminal()) connect(room);
      }, delay);
    });
  };
  const dispose = () => {
    setTerminal(true);
    clearTimers();
    socket?.close();
  };
  if (getOwner()) onCleanup(dispose);

  let saved: RoomDetails | null = null;
  try {
    saved = parseDetails(
      JSON.parse(storage.getItem(ROOM_SESSION_KEY) ?? 'null'),
    );
  } catch {
    storage.removeItem(ROOM_SESSION_KEY);
  }
  if (saved && saved.expiresAt > now()) connect(saved);
  else if (storage.getItem(ROOM_SESSION_KEY)) abandon();

  return {
    status,
    message,
    details,
    snapshot,
    view,
    listenerCount,
    authenticated,
    terminal,
    panelOpen,
    opening,
    closing,
    currentSong,
    async open() {
      if (details()) {
        setPanelOpen(!panelOpen());
        return;
      }
      setOpening(true);
      setStatus('opening');
      try {
        const response = await fetcher('/api/rooms', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        let value: unknown;
        try {
          value = await response.json();
        } catch {
          value = null;
        }
        const room = parseDetails(value);
        if (!response.ok || !room)
          throw new Error(
            isRecord(value) && typeof value.error === 'string'
              ? value.error
              : 'The room could not be opened.',
          );
        storage.setItem(ROOM_SESSION_KEY, JSON.stringify(room));
        connect(room);
      } finally {
        setOpening(false);
      }
    },
    showPanel: setPanelOpen,
    send,
    publishStandalone(url, lyrics) {
      if (!authenticated()) return false;
      let shareId: string;
      try {
        shareId =
          /\/s\/([A-Za-z0-9_-]{16})$/.exec(new URL(url).pathname)?.[1] ?? '';
      } catch {
        return false;
      }
      return (
        SHARE_ID.test(shareId) && send({ type: 'song-shared', shareId, lyrics })
      );
    },
    accept: (requestId) => send({ type: 'request-accepted', requestId }),
    reorder: (requestId, toIndex) =>
      send({ type: 'request-reordered', requestId, toIndex }),
    decline: (requestId) => send({ type: 'request-declined', requestId }),
    kick: (participantId) => send({ type: 'kicked', participantId }),
    closeRoom() {
      if (closing()) return;
      if (!send({ type: 'room-expired' })) {
        setMessage(
          'The room was removed from this device. Its public link will expire automatically.',
        );
        abandon();
        return;
      }
      setClosing(true);
      setStatus('closing');
      // eslint-disable-next-line solid/reactivity -- acknowledgement timeout reads current closing state
      closeTimer = schedule(() => {
        if (closing()) abandon();
      }, 1_500);
    },
    abandon,
  };
}
