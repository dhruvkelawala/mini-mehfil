// @vitest-environment jsdom
import { cleanup, render, screen } from '@solidjs/testing-library';
import { createSignal, Show } from 'solid-js';
import { afterEach, describe, expect, test } from 'vitest';

import {
  App,
  PerformanceTimingCopy,
  TimedSectionView,
} from '../../../src/client/host/App.tsx';
import {
  activePacedLine,
  buildLinePacing,
  effectiveFirstVocalRelease,
} from '../../../src/lyrics/line-pacing.ts';
import {
  buildSectionTimeline,
  parseLyricSheet,
} from '../../../src/lyrics/lyric-sync.ts';
import { vocalGateSeconds } from '../../../src/client/host/vocal-onset.ts';

afterEach(cleanup);

test('renders the host shell with release pacing initialized', () => {
  render(() => <App />);
  expect(screen.getByLabelText(/MiniMax token/)).toBeTruthy();
});

describe('host timed lyric rendering', () => {
  test('upgrades pending copy to one timed section and current line at the existing clock', async () => {
    const sheet = parseLyricSheet({
      isLatinScript: true,
      lyricsNative: '',
      lyricsRoman: '[Verse]\nRain\nWind\nSoft\nGlow\n[Chorus]\nAgain',
    });
    const [pending, setPending] = createSignal(true);
    const [timing, setTiming] =
      createSignal<Parameters<typeof buildSectionTimeline>[1]>(null);
    const timeline = () => buildSectionTimeline(sheet.sections, timing());
    const clock = 8;
    render(() => (
      <>
        <PerformanceTimingCopy
          pending={pending()}
          timed={Boolean(timeline())}
        />
        <Show when={timeline()}>
          {(readyTimeline) => (
            <TimedSectionView
              section={sheet.sections[0]!}
              activeLine={activePacedLine(
                buildLinePacing(sheet.sections, readyTimeline()),
                clock,
              )}
              holdLines={false}
            />
          )}
        </Show>
      </>
    ));

    expect(
      screen.getByText('Analyzing MiniMax sections · music is ready'),
    ).toBeTruthy();
    expect(document.querySelector('.lyric-section')).toBeNull();

    setTiming({
      version: 1,
      mode: 'minimax-section-asr',
      durationSeconds: 20,
      segments: [
        { start: 0, end: 10, label: 'verse' },
        { start: 10, end: 20, label: 'chorus' },
      ],
    });
    setPending(false);
    await Promise.resolve();

    expect(
      screen.getByText('Lines follow MiniMax sections · timing is approximate'),
    ).toBeTruthy();
    expect(document.querySelectorAll('.lyric-section')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });

  test('holds sung lines then reveals the first spoken line from real pacing at gate cutover', async () => {
    const sheet = parseLyricSheet({
      isLatinScript: true,
      lyricsNative: '',
      lyricsRoman: '[Verse]\nRain\nWind\nSoft\nFalling\n[Chorus]\nAgain',
    });
    const section = sheet.sections[0]!;
    const timeline = buildSectionTimeline(sheet.sections, {
      version: 1,
      mode: 'minimax-section-asr',
      durationSeconds: 24,
      segments: [
        { start: 0, end: 20, label: 'verse' },
        { start: 20, end: 24, label: 'chorus' },
      ],
    });
    const detectedGate = vocalGateSeconds(timeline, 12);
    const [release, setRelease] = createSignal<number | null | undefined>(
      undefined,
    );
    const [clock, setClock] = createSignal(2);
    render(() => (
      <TimedSectionView
        section={section}
        activeLine={activePacedLine(
          buildLinePacing(sheet.sections, timeline, release()),
          clock(),
        )}
        holdLines={
          release() === undefined ||
          (release() !== null && clock() < (release() ?? 0))
        }
      />
    ));

    const sectionRoot = document.querySelector('.lyric-section');
    expect(screen.getByText('Verse')).toBeTruthy();
    expect(screen.queryByText('Rain')).toBeNull();

    expect(detectedGate).toBe(8);
    setRelease(effectiveFirstVocalRelease(timeline, detectedGate, 2));
    await Promise.resolve();
    expect(screen.queryByText('Rain')).toBeNull();

    setClock(detectedGate ?? 0);
    await Promise.resolve();
    const current = screen.getByText('Rain').closest('.lyric-line');
    expect(document.querySelector('.lyric-section')).toBe(sectionRoot);
    expect(current?.classList.contains('lyric-line-current')).toBe(true);
    expect(current?.getAttribute('aria-current')).toBe('true');
    expect(screen.getByText('Falling')).toBeTruthy();
  });

  test('starts with line one when detection resolves after its detected gate', async () => {
    const sheet = parseLyricSheet({
      isLatinScript: true,
      lyricsNative: '',
      lyricsRoman: '[Verse]\nRain\nWind\nSoft\nGlow\n[Chorus]\nAgain',
    });
    const section = sheet.sections[0]!;
    const timeline = buildSectionTimeline(sheet.sections, {
      version: 1,
      mode: 'minimax-section-asr',
      durationSeconds: 24,
      segments: [
        { start: 0, end: 20, label: 'verse' },
        { start: 20, end: 24, label: 'chorus' },
      ],
    });
    const detectedGate = vocalGateSeconds(timeline, 12);
    const [release, setRelease] = createSignal<number | null | undefined>(
      undefined,
    );
    const clock = () => 10;
    render(() => (
      <TimedSectionView
        section={section}
        activeLine={activePacedLine(
          buildLinePacing(sheet.sections, timeline, release()),
          clock(),
        )}
        holdLines={release() === undefined}
      />
    ));
    expect(screen.queryByText('Rain')).toBeNull();

    setRelease(effectiveFirstVocalRelease(timeline, detectedGate, clock()));
    await Promise.resolve();

    expect(
      screen
        .getByText('Rain')
        .closest('.lyric-line')
        ?.classList.contains('lyric-line-current'),
    ).toBe(true);
  });

  test('uses original section pacing after a null no-gate result', async () => {
    const sheet = parseLyricSheet({
      isLatinScript: true,
      lyricsNative: '',
      lyricsRoman: '[Verse]\nRain\nWind\nSoft\nGlow',
    });
    const section = sheet.sections[0]!;
    const timeline = [
      { start: 0, end: 20, label: 'verse' as const, sectionIndex: 0 },
    ];
    const [release, setRelease] = createSignal<number | null | undefined>(
      undefined,
    );
    render(() => (
      <TimedSectionView
        section={section}
        activeLine={activePacedLine(
          buildLinePacing(sheet.sections, timeline, release()),
          8,
        )}
        holdLines={release() === undefined}
      />
    ));
    expect(screen.queryByText('Rain')).toBeNull();

    setRelease(null);
    await Promise.resolve();

    expect(
      screen
        .getByText('Wind')
        .closest('.lyric-line')
        ?.classList.contains('lyric-line-current'),
    ).toBe(true);
  });
});
