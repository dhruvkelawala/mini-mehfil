import { describe, expect, test, vi } from 'vitest';

import { createGenerationController } from '../../../src/client/host/generation-controller.ts';
import {
  clearPendingGeneration,
  createJobId,
  GENERATION_STORAGE_KEY,
  readPendingGeneration,
  savePendingGeneration,
  type HostLyrics,
} from '../../../src/client/host/generation-recovery.ts';
import { createMediaDiagnostics } from '../../../src/client/host/media-diagnostics.ts';
import type { PlayerController } from '../../../src/client/host/player-controller.ts';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
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

const lyrics: HostLyrics = {
  title: 'Rain',
  language: 'Hindi',
  languageCode: 'hi',
  nativeScriptName: 'Devanagari',
  isLatinScript: false,
  lyricsNative: 'बारिश',
  lyricsRoman: 'baarish',
  prompt: 'Warm acoustic',
};

function fakePlayer(): PlayerController {
  return {
    ready: () => false,
    playing: () => false,
    title: () => '',
    subtitle: () => '',
    bindAudio: vi.fn(),
    load: vi.fn(() => Promise.resolve()),
    toggle: vi.fn(() => Promise.resolve()),
  };
}

describe('host generation modules', () => {
  test('stores only versioned recovery metadata and clears it', () => {
    const storage = new MemoryStorage();
    const jobId = createJobId();
    expect(jobId).toHaveLength(24);
    savePendingGeneration(storage, jobId, lyrics);
    expect(readPendingGeneration(storage)?.lyricSheet).toEqual(lyrics);
    expect(storage.getItem(GENERATION_STORAGE_KEY)).not.toContain('token');
    clearPendingGeneration(storage);
    expect(readPendingGeneration(storage)).toBeNull();
  });

  test('never starts a second paid request while one is in flight', async () => {
    let releaseLyrics: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      releaseLyrics = resolve;
    });
    let paidCalls = 0;
    const controller = createGenerationController({
      player: fakePlayer(),
      storage: new MemoryStorage(),
      fetcher: async (input) => {
        if (input === '/api/write-lyrics') {
          await wait;
          return Response.json(lyrics);
        }
        paidCalls += 1;
        return Response.json({ data: { audio: '49443304' } });
      },
    });
    const first = controller.generate({
      token: 'secret',
      idea: 'rain',
      vibe: '',
      language: 'auto',
    });
    const second = controller.generate({
      token: 'secret',
      idea: 'rain',
      vibe: '',
      language: 'auto',
    });
    releaseLyrics?.();
    await Promise.all([first, second]);
    expect(paidCalls).toBe(1);
  });

  test('recovers a lost paid response without repeating generation', async () => {
    let paidCalls = 0;
    const player = fakePlayer();
    const controller = createGenerationController({
      player,
      storage: new MemoryStorage(),
      fetcher: (input) => {
        if (input === '/api/write-lyrics')
          return Promise.resolve(Response.json(lyrics));
        if (input.startsWith('/api/generation-status')) {
          return Promise.resolve(
            Response.json({ status: 'complete', data: { audio: '49443304' } }),
          );
        }
        paidCalls += 1;
        return Promise.resolve(
          Response.json({ status: 'pending' }, { status: 202 }),
        );
      },
    });
    await controller.generate({
      token: 'secret',
      idea: 'rain',
      vibe: '',
      language: 'auto',
    });
    expect(paidCalls).toBe(1);
    expect(player.load).toHaveBeenCalledOnce();
  });

  test('records a sanitized playback failure', () => {
    const diagnostics = createMediaDiagnostics();
    diagnostics.recordFailure(new Error('autoplay blocked'));
    expect(diagnostics.visible()).toBe(true);
    expect(diagnostics.report()).toContain('autoplay blocked');
    expect(diagnostics.report()).not.toContain('token');
  });
});
