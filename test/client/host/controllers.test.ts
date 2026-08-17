import { describe, expect, test, vi } from 'vitest';

import { createGenerationController } from '../../../src/client/host/generation-controller.ts';
import {
  activePacedLine,
  buildLinePacing,
} from '../../../src/lyrics/line-pacing.ts';
import {
  clearPendingGeneration,
  createJobId,
  GENERATION_STORAGE_KEY,
  readPendingGeneration,
  savePendingGeneration,
  type HostLyrics,
} from '../../../src/client/host/generation-recovery.ts';
import { createMediaDiagnostics } from '../../../src/client/host/media-diagnostics.ts';
import {
  createPlayerController,
  type PlayerController,
} from '../../../src/client/host/player-controller.ts';
import {
  activeTimelineEntry,
  buildSectionTimeline,
  parseLyricSheet,
} from '../../../src/lyrics/lyric-sync.ts';

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

function fakePlayer(load = vi.fn(() => Promise.resolve())): PlayerController {
  return {
    ready: () => false,
    playing: () => false,
    ended: () => false,
    title: () => '',
    subtitle: () => '',
    duration: () => 0,
    currentTime: () => 0,
    source: () => '',
    analysisBytes: () => null,
    shareReference: () => null,
    timing: () => null,
    bindAudio: vi.fn(),
    load,
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
    const load = vi.fn(() => Promise.resolve());
    const player = fakePlayer(load);
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
    expect(load).toHaveBeenCalledOnce();
  });

  test('records a sanitized playback failure', () => {
    vi.stubGlobal('location', new URL('https://example.test/?mediaDebug=1'));
    const diagnostics = createMediaDiagnostics();
    diagnostics.recordFailure(new Error('autoplay blocked'));
    expect(diagnostics.visible()).toBe(true);
    expect(diagnostics.report()).toContain('autoplay blocked');
    expect(diagnostics.report()).not.toContain('token');
    vi.unstubAllGlobals();
  });

  test('keeps playback diagnostics hidden unless media debug is enabled', () => {
    const diagnostics = createMediaDiagnostics();
    diagnostics.recordFailure(new Error('autoplay blocked'));
    expect(diagnostics.available()).toBe(false);
    expect(diagnostics.visible()).toBe(false);
    expect(diagnostics.report()).toBe('');
  });
});

class FakeAudio {
  readonly listeners = new Map<string, () => void>();
  duration = 0;
  currentTime = 0;
  paused = true;
  src = '';
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  removeAttribute() {}
  load() {}
  pause() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  emit(type: string) {
    this.listeners.get(type)?.();
  }
}

const SECTION_TIMING = {
  version: 1,
  mode: 'minimax-section-asr',
  durationSeconds: 90,
  segments: [
    { start: 0, end: 12, label: 'intro' },
    { start: 12, end: 40, label: 'verse' },
    { start: 40, end: 52, label: 'inst' },
    { start: 52, end: 90, label: 'chorus' },
  ],
};

async function loadedPlayer(timing: unknown, mediaDuration: number) {
  const audio = new FakeAudio();
  const player = createPlayerController(createMediaDiagnostics());
  player.bindAudio(audio as unknown as HTMLAudioElement);
  await player.load('https://cdn.example/song.mp3', lyrics, null, timing);
  audio.duration = mediaDuration;
  audio.emit('loadedmetadata');
  return { audio, player };
}

describe('host section timing', () => {
  test('activates timed mode only when the media matches the analyzed length', async () => {
    const cases: Array<[string, number, boolean]> = [
      ['an exact match', 90, true],
      ['drift inside the one second floor', 90.9, true],
      ['drift inside two percent of a long track', 91.8, true],
      ['drift past the two percent ceiling', 93, false],
      ['a materially shorter file', 60, false],
      ['a media element with no duration yet', Number.NaN, false],
    ];
    for (const [name, mediaDuration, expected] of cases) {
      const { player } = await loadedPlayer(SECTION_TIMING, mediaDuration);
      expect(Boolean(player.timing()), name).toBe(expected);
    }
  });

  test('falls back to no timing for absent or out-of-contract artifacts', async () => {
    for (const timing of [
      undefined,
      null,
      { version: 2, mode: 'minimax-section-asr', durationSeconds: 90 },
      { ...SECTION_TIMING, mode: 'guesswork' },
    ]) {
      const { player } = await loadedPlayer(timing, 90);
      expect(player.timing()).toBeNull();
      expect(buildSectionTimeline([], player.timing())).toBeNull();
    }
  });

  test('selects the section the media clock is inside, forwards and backwards', async () => {
    const { player } = await loadedPlayer(SECTION_TIMING, 90);
    const sheet = parseLyricSheet({
      isLatinScript: true,
      lyricsNative: '',
      lyricsRoman:
        '[Intro]\nOoh\n[Verse]\nRain on the window\n[Inst]\n—\n[Chorus]\nSing it back',
    });
    const timeline = buildSectionTimeline(sheet.sections, player.timing());
    const sectionAt = (time: number) =>
      activeTimelineEntry(timeline, time)?.sectionIndex;

    expect(sectionAt(0)).toBe(0);
    expect(sectionAt(11.999)).toBe(0);
    expect(sectionAt(12)).toBe(1);
    expect(sectionAt(45)).toBe(2);
    expect(sectionAt(52)).toBe(3);
    expect(sectionAt(89.999)).toBe(3);
    // A backward seek is a fresh lookup, never a rewound cursor.
    expect(sectionAt(5)).toBe(0);
    // Past the end of the analyzed audio nothing is active, so no stale
    // section can linger on screen.
    expect(activeTimelineEntry(timeline, 90)).toBeNull();
  });

  test('activates derived line pacing only with a validated section timeline', async () => {
    const { player } = await loadedPlayer(SECTION_TIMING, 90);
    const sheet = parseLyricSheet({
      isLatinScript: true,
      lyricsNative: '',
      lyricsRoman:
        '[Intro]\nSoftly now\n[Verse]\nbanana papaya\nsoft rain\n[Inst]\n—\n[Chorus]\nSing it back',
    });
    const timeline = buildSectionTimeline(sheet.sections, player.timing());
    const pacing = buildLinePacing(sheet.sections, timeline);
    expect(activePacedLine(pacing, 19)?.sectionIndex).toBe(1);
    expect(buildLinePacing(sheet.sections, null)).toEqual([]);
  });

  test('exposes analysis bytes only for inline-hex audio and skips remote URLs', async () => {
    const audio = new FakeAudio();
    const player = createPlayerController(createMediaDiagnostics());
    player.bindAudio(audio as unknown as HTMLAudioElement);

    await player.load('49443304', lyrics, null, SECTION_TIMING);
    expect(
      new Uint8Array(player.analysisBytes() ?? new ArrayBuffer(0)),
    ).toEqual(new Uint8Array([73, 68, 51, 4]));

    await player.load(
      'https://cdn.example/song.mp3',
      lyrics,
      null,
      SECTION_TIMING,
    );
    expect(player.analysisBytes()).toBeNull();
  });

  test('drops timing when a different recording is loaded or the player clears', async () => {
    const { audio, player } = await loadedPlayer(SECTION_TIMING, 90);
    expect(player.timing()).not.toBeNull();

    player.clear();
    expect(player.timing()).toBeNull();

    await player.load('https://cdn.example/other.mp3', lyrics, null, undefined);
    audio.duration = 90;
    audio.emit('loadedmetadata');
    expect(player.timing()).toBeNull();
  });
});
