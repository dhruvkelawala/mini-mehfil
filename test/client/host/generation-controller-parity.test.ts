import { describe, expect, test, vi } from 'vitest';

import { createGenerationController } from '../../../src/client/host/generation-controller.ts';
import {
  GENERATION_STORAGE_KEY,
  type HostLyrics,
} from '../../../src/client/host/generation-recovery.ts';
import type { PlayerController } from '../../../src/client/host/player-controller.ts';

const SHEET: HostLyrics = {
  title: 'Rain',
  language: 'Hindi',
  languageCode: 'hi',
  nativeScriptName: 'Devanagari',
  isLatinScript: false,
  lyricsNative: 'बारिश',
  lyricsRoman: 'baarish',
  prompt: 'warm',
};
const INPUT = { token: 'secret', idea: 'rain', vibe: '', language: 'auto' };
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
function player(): PlayerController {
  return {
    ready: () => false,
    playing: () => false,
    ended: () => false,
    title: () => '',
    subtitle: () => '',
    duration: () => 0,
    currentTime: () => 0,
    source: () => '',
    shareReference: () => null,
    bindAudio: vi.fn(),
    load: vi.fn(() => Promise.resolve()),
    loadRoomSong: vi.fn(),
    syncRoomSong: vi.fn(),
    clear: vi.fn(),
    play: vi.fn(() => Promise.resolve(true)),
    pause: vi.fn(),
    toggle: vi.fn(() => Promise.resolve()),
    seek: vi.fn(),
    replay: vi.fn(() => Promise.resolve()),
  };
}
const completeFetch = (input: string) =>
  Promise.resolve(
    input === '/api/write-lyrics'
      ? Response.json(SHEET)
      : Response.json({
          data: { audio: '49443304' },
          share_ref: 'reference',
        }),
  );

describe('typed generation lifecycle parity', () => {
  test('loading messages keep looping and user-facing copy contains no em dashes', async () => {
    let release: (() => void) | undefined;
    const controller = createGenerationController({
      player: player(),
      storage: new MemoryStorage(),
      fetcher: async (input) => {
        if (input === '/api/write-lyrics')
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return completeFetch(input);
      },
    });
    const pending = controller.generate(INPUT);
    await Promise.resolve();
    expect(controller.busyLines().length).toBeGreaterThan(1);
    expect(controller.busyLines().join(' ')).not.toContain('—');
    release?.();
    await pending;
  });

  test('a new generation clears the previous recording before changing lyric state', async () => {
    const target = player();
    const controller = createGenerationController({
      player: target,
      storage: new MemoryStorage(),
      fetcher: completeFetch,
    });
    await controller.generate(INPUT);
    const clearOrder =
      (target.clear as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
      0;
    const loadOrder =
      (target.load as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
      0;
    expect(clearOrder).toBeLessThan(loadOrder);
  });

  test('generation recovery is wired without retrying the paid request', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      GENERATION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        jobId: 'AbCdEfGhIjKlMnOpQrStUvWx',
        createdAt: new Date().toISOString(),
        lyricSheet: SHEET,
      }),
    );
    const urls: string[] = [];
    const controller = createGenerationController({
      player: player(),
      storage,
      fetcher: async (input) => {
        urls.push(input);
        return Response.json({
          jobId: 'AbCdEfGhIjKlMnOpQrStUvWx',
          status: 'complete',
          data: { audio: '49443304' },
        });
      },
    });
    expect(controller.resumePending('page-load')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(urls).toEqual([
      '/api/generation-status?id=AbCdEfGhIjKlMnOpQrStUvWx',
    ]);
  });

  test('background, foreground, and pageshow preserve the ordinary recording UI without another paid request', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      GENERATION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        jobId: 'AbCdEfGhIjKlMnOpQrStUvWx',
        createdAt: new Date().toISOString(),
        lyricSheet: SHEET,
      }),
    );
    let checks = 0;
    const controller = createGenerationController({
      player: player(),
      storage,
      fetcher: async () => {
        checks += 1;
        return Response.json({ status: 'pending' });
      },
    });
    controller.lifecycleBackgrounded();
    controller.lifecycleForegrounded();
    controller.resumePending('pageshow');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checks).toBe(1);
    expect(controller.generating()).toBe(true);
  });

  test('a lyric request lost across background and foreground retries silently before the paid request', async () => {
    let lyricCalls = 0;
    let paidCalls = 0;
    const controller = createGenerationController({
      player: player(),
      storage: new MemoryStorage(),
      fetcher: async (input) => {
        if (input === '/api/write-lyrics') {
          lyricCalls += 1;
          if (lyricCalls === 1) {
            controller.lifecycleBackgrounded();
            throw new TypeError('network lost');
          }
          return Response.json(SHEET);
        }
        paidCalls += 1;
        return Response.json({ data: { audio: '49443304' } });
      },
    });
    await controller.generate(INPUT);
    expect(lyricCalls).toBe(2);
    expect(paidCalls).toBe(1);
  });

  test('a lyric network failure without a lifecycle interruption remains actionable', async () => {
    const controller = createGenerationController({
      player: player(),
      storage: new MemoryStorage(),
      fetcher: () => Promise.reject(new TypeError('Network unavailable')),
    });
    await expect(controller.generate(INPUT)).rejects.toThrow(
      'Network unavailable',
    );
    expect(controller.status()).toBe('Network unavailable');
    expect(controller.checkGenerationVisible()).toBe(false);
  });

  test('only a genuine status outage reveals a neutral Check generation action', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      GENERATION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        jobId: 'AbCdEfGhIjKlMnOpQrStUvWx',
        createdAt: new Date().toISOString(),
        lyricSheet: SHEET,
      }),
    );
    const controller = createGenerationController({
      player: player(),
      storage,
      fetcher: async () => Response.json({ error: 'outage' }, { status: 503 }),
    });
    controller.resumePending('page-load');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.checkGenerationVisible()).toBe(true);
    expect(controller.status()).toMatch(/trouble checking/i);
  });

  test('standalone generation is extracted behind a thin form caller', async () => {
    const ready = vi.fn();
    const controller = createGenerationController({
      player: player(),
      storage: new MemoryStorage(),
      fetcher: completeFetch,
    });
    await controller.generate(INPUT, { onReady: ready });
    expect(ready).toHaveBeenCalledWith(
      expect.objectContaining({
        lyricSheet: SHEET,
        shareReference: 'reference',
      }),
    );
  });

  test('a stale share request cannot mutate a later generation', async () => {
    let release: (() => void) | undefined;
    const controller = createGenerationController({
      player: player(),
      storage: new MemoryStorage(),
      fetcher: async (input) => {
        if (input === '/api/write-lyrics') return Response.json(SHEET);
        if (input === '/api/generate')
          return Response.json({
            data: { audio: '49443304' },
            share_ref: 'reference',
          });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return Response.json({
          url: 'https://rooms.example/s/AbCdEfGhIjKlMnOp',
        });
      },
    });
    await controller.generate(INPUT);
    const stale = controller.share(false);
    controller.cancelForReplacement();
    release?.();
    expect(await stale).toBeUndefined();
    expect(controller.shareUrl()).toBeNull();
  });
});
