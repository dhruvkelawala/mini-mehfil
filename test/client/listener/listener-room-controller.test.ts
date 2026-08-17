// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { LyricTiming } from '../../../src/lyrics/lyric-sync.ts';
import { createListenerRoomController } from '../../../src/client/listener/listener-room-controller.ts';

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
  readyState = 0;
  readonly sent: string[] = [];
  send(value: string) {
    this.sent.push(value);
  }
  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  message(state: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'snapshot', state }),
      }),
    );
  }
  close(code = 1000) {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code }));
  }
}

class FakeAudio extends EventTarget {
  readyState = 0;
  duration = Number.NaN;
  currentTime = 0;
  paused = true;
  ended = false;
  src = '';
  readonly load = vi.fn(() => {
    this.readyState = 0;
  });
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  metadata(duration: number) {
    this.duration = duration;
    this.readyState = 1;
    this.dispatchEvent(new Event('loadedmetadata'));
  }
}

const TIMING = {
  version: 1,
  mode: 'minimax-section-asr',
  durationSeconds: 90,
  segments: [
    { start: 0, end: 45, label: 'verse' },
    { start: 45, end: 90, label: 'chorus' },
  ],
} satisfies LyricTiming;

const snapshot = ({
  shareId = 'AbCdEfGhIjKlMnOp',
  playback = { status: 'paused' as const, positionMs: 30_000, changedAt: 1 },
  lyricTiming,
}: {
  shareId?: string;
  playback?: {
    status: 'playing' | 'paused';
    positionMs: number;
    changedAt: number;
  };
  lyricTiming?: LyricTiming | null;
}) => ({
  hostPresent: true,
  listenerCount: 1,
  queue: [],
  currentRecording: null,
  currentSong: {
    shareId,
    title: 'Rain',
    language: 'Hindi',
    lyrics: {
      title: 'Rain',
      language: 'Hindi',
      nativeScriptName: 'Devanagari',
      isLatinScript: false,
      lyricsNative: '[Verse]\nबारिश\n[Chorus]\nफिर',
      lyricsRoman: '[Verse]\nbaarish\n[Chorus]\nphir',
    },
    playback,
    ...(lyricTiming === undefined ? {} : { lyricTiming }),
  },
  setlist: [],
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('listener room timing and media clock', () => {
  test('applies late timing without moving playback and rejects duration drift', () => {
    const socket = new FakeSocket();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const controller = createListenerRoomController({
      roomId: 'ABCDEFGH',
      storage: new MemoryStorage(),
      socketFactory: () => socket as unknown as WebSocket,
    });
    const audio = new FakeAudio();
    controller.bindAudio(audio as unknown as HTMLAudioElement);
    controller.connect('Ada');
    socket.open();
    socket.message(snapshot({}));
    audio.metadata(90);
    expect(audio.currentTime).toBe(30);
    expect(controller.timing()).toBeNull();

    socket.message(snapshot({ lyricTiming: TIMING }));
    expect(audio.currentTime).toBe(30);
    expect(controller.currentTime()).toBe(30);
    expect(controller.timing()).toEqual(TIMING);
    expect(fetchSpy).not.toHaveBeenCalled();

    socket.message(
      snapshot({
        shareId: 'QrStUvWxYz012345',
        playback: { status: 'paused', positionMs: 10_000, changedAt: 2 },
        lyricTiming: {
          ...TIMING,
          durationSeconds: 60,
          segments: [
            { start: 0, end: 30, label: 'verse' },
            { start: 30, end: 60, label: 'chorus' },
          ],
        },
      }),
    );
    audio.metadata(90);
    expect(audio.currentTime).toBe(10);
    expect(controller.timing()).toBeNull();
    controller.close();
  });

  test('follows pause, resume, seeks, reconnect, and late metadata from snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sockets: FakeSocket[] = [];
    const controller = createListenerRoomController({
      roomId: 'ABCDEFGH',
      storage: new MemoryStorage(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const audio = new FakeAudio();
    controller.bindAudio(audio as unknown as HTMLAudioElement);
    controller.connect('Ada');
    sockets[0]?.open();
    sockets[0]?.message(snapshot({ lyricTiming: TIMING }));
    expect(controller.timing()).toBeNull();
    audio.metadata(90);
    expect(audio.currentTime).toBe(30);
    expect(controller.timing()).toEqual(TIMING);

    sockets[0]?.message(
      snapshot({
        playback: {
          status: 'playing',
          positionMs: 30_000,
          changedAt: 1_000,
        },
        lyricTiming: TIMING,
      }),
    );
    await Promise.resolve();
    expect(audio.currentTime).toBe(30);
    expect(controller.playing()).toBe(true);

    vi.setSystemTime(2_000);
    sockets[0]?.message(
      snapshot({
        playback: {
          status: 'paused',
          positionMs: 5_000,
          changedAt: 2_000,
        },
        lyricTiming: TIMING,
      }),
    );
    expect(audio.currentTime).toBe(5);
    expect(controller.playing()).toBe(false);

    sockets[0]?.message(
      snapshot({
        playback: {
          status: 'paused',
          positionMs: 50_000,
          changedAt: 2_001,
        },
        lyricTiming: TIMING,
      }),
    );
    expect(audio.currentTime).toBe(50);

    sockets[0]?.close(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    sockets[1]?.message(
      snapshot({
        playback: {
          status: 'paused',
          positionMs: 12_000,
          changedAt: 3_000,
        },
        lyricTiming: TIMING,
      }),
    );
    expect(audio.currentTime).toBe(12);
    expect(controller.timing()).toEqual(TIMING);
    controller.close();
  });
});
