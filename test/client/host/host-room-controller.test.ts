import { describe, expect, test, vi } from 'vitest';

import type { LyricsSheet, RoomState } from '../../../src/room/protocol.ts';
import { projectRoomState } from '../../../src/room/state.ts';
import {
  createHostRoomController,
  hostRoomView,
  ROOM_SESSION_KEY,
  roomReorderTargets,
} from '../../../src/client/host/host-room-controller.ts';

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 0;
  readonly sent: string[] = [];
  throwOnSend = false;
  send(value: string) {
    if (this.throwOnSend) throw new Error('socket closed');
    this.sent.push(value);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  }
  message(value: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(value) }),
    );
  }
}
const DETAILS = {
  roomId: 'ABCDEFGH',
  joinUrl: 'https://rooms.example/r/ABCDEFGH',
  socketUrl: 'wss://rooms.example/rooms/ABCDEFGH/ws',
  hostSecret: 'A'.repeat(43),
  expiresAt: Date.now() + 60_000,
};
const LYRICS: LyricsSheet = {
  title: 'Rain',
  language: 'Hindi',
  nativeScriptName: 'Devanagari',
  isLatinScript: false,
  lyricsNative: 'बारिश',
  lyricsRoman: 'baarish',
};
const state = (): RoomState => ({
  version: 1,
  roomId: 'ABCDEFGH',
  openedAt: 1,
  expiresAt: Date.now() + 60_000,
  expiredAt: null,
  hostPresent: true,
  participants: [],
  kickedParticipantIds: [],
  queue: [],
  recordingQueue: [],
  currentRecording: null,
  currentSong: null,
  setlist: [],
});
const hostSnapshot = () => projectRoomState(state(), { role: 'host' });

describe('typed host room parity', () => {
  test('host room credentials remain session-only and authenticate first', () => {
    const storage = new MemoryStorage();
    storage.setItem(ROOM_SESSION_KEY, JSON.stringify(DETAILS));
    const socket = new FakeSocket();
    createHostRoomController({
      storage,
      socketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      type: 'auth-host',
      secret: DETAILS.hostSecret,
    });
    expect([...storage.values.values()].join('')).toContain(DETAILS.hostSecret);
  });

  test('main generation publishes its finished song into an active room', () => {
    const storage = new MemoryStorage();
    storage.setItem(ROOM_SESSION_KEY, JSON.stringify(DETAILS));
    const socket = new FakeSocket();
    const room = createHostRoomController({
      storage,
      socketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ type: 'snapshot', state: hostSnapshot() });
    expect(
      room.publishStandalone(
        'https://rooms.example/s/AbCdEfGhIjKlMnOp',
        LYRICS,
      ),
    ).toBe(true);
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({
      type: 'song-shared',
      shareId: 'AbCdEfGhIjKlMnOp',
      lyrics: LYRICS,
    });
  });

  test('host player publishes authoritative room playback', () => {
    const storage = new MemoryStorage();
    storage.setItem(ROOM_SESSION_KEY, JSON.stringify(DETAILS));
    const socket = new FakeSocket();
    const room = createHostRoomController({
      storage,
      socketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ type: 'snapshot', state: hostSnapshot() });
    expect(
      room.send({
        type: 'playback-updated',
        shareId: 'AbCdEfGhIjKlMnOp',
        status: 'playing',
        positionMs: 1234,
      }),
    ).toBe(true);
    const message: unknown = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(message).toEqual(
      expect.objectContaining({ type: 'playback-updated' }),
    );
  });

  test('socket send failures return false and mark the room offline', () => {
    const storage = new MemoryStorage();
    storage.setItem(ROOM_SESSION_KEY, JSON.stringify(DETAILS));
    const socket = new FakeSocket();
    const room = createHostRoomController({
      storage,
      socketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ type: 'snapshot', state: hostSnapshot() });
    socket.throwOnSend = true;
    expect(room.accept('q1')).toBe(false);
    expect(room.status()).toBe('offline');
  });
  test('host room treats auth close as terminal and waits for expiry acknowledgement', () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    storage.setItem(ROOM_SESSION_KEY, JSON.stringify(DETAILS));
    const socket = new FakeSocket();
    const room = createHostRoomController({
      storage,
      socketFactory: () => socket as unknown as WebSocket,
    });
    socket.open();
    socket.message({ type: 'snapshot', state: hostSnapshot() });
    room.closeRoom();
    expect(room.closing()).toBe(true);
    expect(room.details()).not.toBeNull();
    vi.advanceTimersByTime(1_500);
    expect(room.details()).toBeNull();
    vi.useRealTimers();
  });

  test('host reorder targets use full queue indices when terminal rows are hidden', () => {
    const queue = [
      { id: 'done', status: 'ready' },
      { id: 'a', status: 'pending' },
      { id: 'declined', status: 'declined' },
      { id: 'b', status: 'accepted' },
    ] as RoomState['queue'];
    expect(roomReorderTargets(queue, 'a')).toEqual({ up: 1, down: 3 });
    expect(roomReorderTargets(queue, 'b')).toEqual({ up: 1, down: 3 });
  });

  test('host view covers every participant, requester names, and Worker-origin setlist links', () => {
    const current = state();
    current.participants = [
      { id: 'p1', name: 'Ada', connected: true, joinedAt: 1 },
      { id: 'p2', name: '', connected: true, joinedAt: 2 },
    ];
    current.queue = [
      {
        id: 'q1',
        participantId: 'p1',
        idea: 'Rain',
        vibe: '',
        language: 'Hindi',
        status: 'pending',
        submittedAt: 3,
      },
    ];
    current.setlist = [
      {
        requestId: 'q1',
        shareId: 'AbCdEfGhIjKlMnOp',
        title: 'Rain',
        language: 'Hindi',
        startedAt: 4,
        lyrics: LYRICS,
      },
    ];
    const view = hostRoomView(current, DETAILS.joinUrl);
    expect(view.participants.map((item) => item.name)).toEqual([
      'Ada',
      'Listener',
    ]);
    expect(view.queue[0]?.requesterName).toBe('Ada');
    expect(view.setlist[0]?.url).toBe(
      'https://rooms.example/s/AbCdEfGhIjKlMnOp',
    );
  });

  test('host can abandon a room that cannot reconnect', () => {
    const storage = new MemoryStorage();
    storage.setItem(ROOM_SESSION_KEY, JSON.stringify(DETAILS));
    const socket = new FakeSocket();
    const room = createHostRoomController({
      storage,
      socketFactory: () => socket as unknown as WebSocket,
    });
    room.abandon();
    expect(room.terminal()).toBe(true);
    expect(room.send({ type: 'room-expired' })).toBe(false);
    expect(storage.getItem(ROOM_SESSION_KEY)).toBeNull();
  });
});
