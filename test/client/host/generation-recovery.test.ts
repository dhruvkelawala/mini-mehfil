import { describe, expect, test, vi } from 'vitest';

import {
  createJobId,
  createRecoveryCoordinator,
  GENERATION_STORAGE_KEY,
  type HostLyrics,
  type StatusResponse,
} from '../../../src/client/host/generation-recovery.ts';

const JOB_ID = 'AbCdEfGhIjKlMnOpQrStUvWx';
const SHEET: HostLyrics = {
  title: 'Monsoon Song',
  language: 'Gujarati',
  languageCode: 'gu',
  nativeScriptName: 'Gujarati',
  isLatinScript: false,
  lyricsNative: 'વરસાદ',
  lyricsRoman: 'varsaad',
  prompt: 'Warm monsoon folk',
};
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
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('generation recovery parity', () => {
  test('job IDs use 18 cryptographic bytes and match the exact contract', () => {
    let requested = 0;
    const cryptoSource = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        const bytes = array as Uint8Array;
        requested = bytes.length;
        bytes.set(Array.from({ length: 18 }, (_, index) => index));
        return array;
      },
    } as Crypto;
    expect(createJobId(cryptoSource)).toBe('AAECAwQFBgcICQoLDA0ODxAR');
    expect(requested).toBe(18);
  });

  test('pending session records round trip only whitelisted recovery fields', () => {
    const storage = new MemoryStorage();
    const coordinator = createRecoveryCoordinator({
      storage,
      now: () => Date.parse('2026-08-15T12:00:00Z'),
    });
    coordinator.save({
      jobId: JOB_ID,
      lyricSheet: { ...SHEET, token: 'secret' } as HostLyrics,
    });
    expect(coordinator.read()).toEqual({
      version: 1,
      jobId: JOB_ID,
      createdAt: '2026-08-15T12:00:00.000Z',
      lyricSheet: SHEET,
      context: null,
    });
    expect(storage.getItem(GENERATION_STORAGE_KEY)).not.toMatch(
      /secret|private/,
    );
  });

  test('room recovery context round trips without storing a token or prompt outside the lyric sheet', () => {
    const storage = new MemoryStorage();
    const coordinator = createRecoveryCoordinator({ storage });
    coordinator.save({
      jobId: JOB_ID,
      lyricSheet: SHEET,
      context: {
        kind: 'room-recording',
        roomId: 'ABCDEFGH',
        requestId: 'request-b',
      },
    });
    expect(coordinator.read()?.context).toEqual({
      kind: 'room-recording',
      roomId: 'ABCDEFGH',
      requestId: 'request-b',
    });
    expect(storage.getItem(GENERATION_STORAGE_KEY)).not.toContain('token');
  });

  test('invalid, corrupt, version-mismatched, and expired records are cleared', () => {
    const storage = new MemoryStorage();
    const coordinator = createRecoveryCoordinator({
      storage,
      now: () => Date.parse('2026-08-16T12:00:00.001Z'),
    });
    for (const value of [
      '{',
      JSON.stringify({ version: 2 }),
      JSON.stringify({
        version: 1,
        jobId: 'bad',
        createdAt: '2026-08-15T12:00:00Z',
        lyricSheet: SHEET,
      }),
      JSON.stringify({
        version: 1,
        jobId: JOB_ID,
        createdAt: '2026-08-15T12:00:00Z',
        lyricSheet: SHEET,
      }),
    ]) {
      storage.setItem(GENERATION_STORAGE_KEY, value);
      expect(coordinator.read()).toBeNull();
      expect(storage.getItem(GENERATION_STORAGE_KEY)).toBeNull();
    }
  });

  test('polling is visible-only, single-loop, bounded, and finalizes once', async () => {
    let visible = false;
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const completed: Record<string, unknown>[] = [];
    const responses: StatusResponse[] = [
      { ok: true, status: 200, value: { status: 'pending' } },
      { ok: true, status: 200, value: { status: 'pending' } },
      {
        ok: true,
        status: 200,
        value: { status: 'complete', data: { audio: 'song' } },
      },
    ];
    const coordinator = createRecoveryCoordinator({
      visibility: () => visible,
      fetchStatus: async () =>
        responses.shift() ?? { ok: false, status: 500, value: {} },
      schedule(callback, delay) {
        scheduled.push({ callback, delay });
        return 1;
      },
      cancelSchedule: vi.fn(),
      onComplete: (value) => completed.push(value),
    });
    const pending = {
      version: 1 as const,
      jobId: JOB_ID,
      createdAt: new Date().toISOString(),
      lyricSheet: SHEET,
    };
    coordinator.start(pending, 1);
    coordinator.start(pending, 1);
    expect(scheduled).toHaveLength(0);
    visible = true;
    coordinator.resume();
    await settle();
    const first = scheduled.shift();
    expect(first?.delay).toBe(2_000);
    first?.callback();
    await settle();
    const second = scheduled.shift();
    expect(second?.delay).toBe(3_000);
    second?.callback();
    await settle();
    expect(completed).toHaveLength(1);
    coordinator.resume();
    await settle();
    expect(completed).toHaveLength(1);
  });

  test('retryable failures retain state and cancellation blocks stale finalization', async () => {
    let resolveStatus: ((response: StatusResponse) => void) | undefined;
    const completed = vi.fn();
    const coordinator = createRecoveryCoordinator({
      visibility: () => true,
      fetchStatus: () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
      onComplete: completed,
    });
    coordinator.start(
      {
        version: 1,
        jobId: JOB_ID,
        createdAt: new Date().toISOString(),
        lyricSheet: SHEET,
      },
      1,
    );
    await settle();
    coordinator.cancel();
    resolveStatus?.({ ok: true, status: 200, value: { status: 'complete' } });
    await settle();
    expect(completed).not.toHaveBeenCalled();
    const retryable = vi.fn();
    const failing = createRecoveryCoordinator({
      visibility: () => true,
      fetchStatus: async () => ({
        ok: false,
        status: 503,
        value: { error: 'Try later' },
      }),
      onRetryable: retryable,
    });
    failing.start(
      {
        version: 1,
        jobId: JOB_ID,
        createdAt: new Date().toISOString(),
        lyricSheet: SHEET,
      },
      2,
    );
    await settle();
    expect(retryable).toHaveBeenCalledWith(
      { status: 503, message: 'Try later' },
      expect.objectContaining({ jobId: JOB_ID }),
    );
    expect(failing.current()?.jobId).toBe(JOB_ID);
  });

  test('failed and missing jobs stop with phase-specific callbacks', async () => {
    const events: string[] = [];
    for (const response of [
      { ok: true, status: 200, value: { status: 'failed', error: 'No song.' } },
      { ok: false, status: 404, value: { error: 'Gone.' } },
    ] satisfies StatusResponse[]) {
      const coordinator = createRecoveryCoordinator({
        visibility: () => true,
        fetchStatus: async () => response,
        onFailed: () => events.push('failed'),
        onExpired: () => events.push('expired'),
      });
      coordinator.start(
        {
          version: 1,
          jobId: JOB_ID,
          createdAt: new Date().toISOString(),
          lyricSheet: SHEET,
        },
        1,
      );
      await settle();
    }
    expect(events).toEqual(['failed', 'expired']);
  });
});
