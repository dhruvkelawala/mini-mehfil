// @vitest-environment jsdom
import { cleanup, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { LyricPerformance } from '../../../src/client/shared/LyricPerformance.tsx';
import {
  buildLyricLinePacing,
  lyricFrameAt,
  parseLyricTimeline,
} from '../../../src/client/shared/lyric-timeline.ts';
import { parseLyricSheet } from '../../../src/lyrics/lyric-sync.ts';

afterEach(cleanup);

describe('shared lyric performance semantics', () => {
  test('uses Latin lyrics as the sole primary script and ignores blank positions', () => {
    const parsed = parseLyricSheet({
      isLatinScript: true,
      lyricsNative: '',
      lyricsRoman:
        '[Verse]\n\nRain on the window\n[Pre-Chorus]\n\nSing it home',
    });

    expect(parsed.lines.map((line) => line.primary)).toEqual([
      'Verse',
      'Rain on the window',
      'Pre-Chorus',
      'Sing it home',
    ]);
    expect(parsed.lines.filter((line) => line.cue)).toHaveLength(2);
    expect(parsed.lines.every((line) => line.secondary === '')).toBe(true);
  });

  test('keeps native and romanized sections aligned when one script omits a line', () => {
    const parsed = parseLyricSheet({
      isLatinScript: false,
      lyricsNative:
        '[Verse]\nपहली पंक्ति\nदूसरी पंक्ति\n[Chorus]\nआख़िरी पंक्ति',
      lyricsRoman: '[Verse]\nPehli pankti\n[Chorus]\nAakhiri pankti',
    });

    expect(
      parsed.sections.map((section) => ({
        cue: section.lines.find((line) => line.cue)?.primary,
        primary: section.lines
          .filter((line) => !line.cue)
          .map((line) => line.primary),
        secondary: section.lines
          .filter((line) => !line.cue)
          .map((line) => line.secondary),
      })),
    ).toEqual([
      {
        cue: 'Verse',
        primary: ['पहली पंक्ति', 'दूसरी पंक्ति'],
        secondary: ['Pehli pankti', ''],
      },
      {
        cue: 'Chorus',
        primary: ['आख़िरी पंक्ति'],
        secondary: ['Aakhiri pankti'],
      },
    ]);
    expect(
      parsed.lines.some((line) => !line.cue && /^\[.+\]$/.test(line.primary)),
    ).toBe(false);
    expect(parsed.lines.some((line) => /^\[.+\]$/.test(line.secondary))).toBe(
      false,
    );
  });

  test('projects the first, middle, and final untimed frames safely', () => {
    const timeline = parseLyricTimeline({
      isLatinScript: false,
      lyricsNative:
        '[Verse]\nपहली पंक्ति\nदूसरी पंक्ति\nतीसरी पंक्ति\nचौथी पंक्ति',
      lyricsRoman:
        '[Verse]\nPehli pankti\nDoosri pankti\nTeesri pankti\nChauthi pankti',
    });

    expect(lyricFrameAt(timeline, 0, 0)).toMatchObject({
      kind: 'line',
      cue: 'Verse',
      line: { primary: 'पहली पंक्ति', secondary: 'Pehli pankti' },
    });
    expect(lyricFrameAt(timeline, 70, 120)).toMatchObject({
      kind: 'line',
      cue: 'Verse',
      line: { primary: 'तीसरी पंक्ति', secondary: 'Teesri pankti' },
    });
    expect(lyricFrameAt(timeline, 108, 120)).toMatchObject({
      kind: 'line',
      line: { primary: 'चौथी पंक्ति' },
    });
    expect(lyricFrameAt(timeline, 999, 120)).toMatchObject({
      kind: 'line',
      line: { primary: 'चौथी पंक्ति' },
    });
    expect(lyricFrameAt(timeline, Number.NaN, 120)).toMatchObject({
      kind: 'line',
      line: { primary: 'पहली पंक्ति' },
    });
  });

  test('renders a reactive live stage and a complete transcript from one component', async () => {
    const timeline = parseLyricTimeline({
      isLatinScript: false,
      lyricsNative:
        '[Verse]\nपहली पंक्ति\nदूसरी पंक्ति\n[Chorus]\nतीसरी पंक्ति\nचौथी पंक्ति',
      lyricsRoman:
        '[Verse]\nPehli pankti\nDoosri pankti\n[Chorus]\nTeesri pankti\nChauthi pankti',
    });
    const [clock, setClock] = createSignal(0);
    const view = render(() => (
      <LyricPerformance
        timeline={timeline}
        title="Four-line Song"
        language="Hindi · Devanagari"
        currentTime={clock()}
        duration={120}
        mode="live"
      />
    ));

    expect(
      screen.getByRole('heading', { name: 'Four-line Song' }),
    ).toBeTruthy();
    expect(screen.getByText('Hindi · Devanagari')).toBeTruthy();
    expect(screen.getByText('Verse')).toBeTruthy();
    expect(screen.getByText('पहली पंक्ति')).toBeTruthy();
    expect(screen.getByText('Pehli pankti')).toBeTruthy();
    expect(
      document.querySelectorAll('.lyric-line:not([hidden]) .lyric-primary'),
    ).toHaveLength(1);

    setClock(70);
    await Promise.resolve();
    expect(screen.getByText('तीसरी पंक्ति')).toBeTruthy();
    expect(screen.getByText('Teesri pankti')).toBeTruthy();
    expect(screen.getByText('पहली पंक्ति')).toBeTruthy();
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0);

    view.unmount();
    render(() => (
      <LyricPerformance
        timeline={timeline}
        title="Four-line Song"
        language="Hindi · Devanagari"
        currentTime={70}
        duration={120}
        mode="transcript"
      />
    ));
    for (const line of [
      'पहली पंक्ति',
      'दूसरी पंक्ति',
      'तीसरी पंक्ति',
      'चौथी पंक्ति',
    ])
      expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByText('Chorus')).toBeTruthy();
    expect(
      document.querySelector('.lyric-performance--transcript'),
    ).toBeTruthy();
    expect(
      document.querySelectorAll('.lyric-performance__section'),
    ).toHaveLength(2);
  });

  test('preserves provider-timed section and line emphasis', () => {
    const timeline = parseLyricTimeline(
      {
        isLatinScript: true,
        lyricsRoman:
          '[Verse]\nRain falls\nWind calls\n[Chorus]\nSing again\nSing home',
      },
      {
        version: 1,
        mode: 'minimax-section-asr',
        durationSeconds: 20,
        segments: [
          { start: 0, end: 10, label: 'verse' },
          { start: 10, end: 20, label: 'chorus' },
        ],
      },
    );

    render(() => (
      <LyricPerformance
        timeline={timeline}
        title="Rain Song"
        language="English"
        currentTime={16}
        duration={20}
        mode="live"
      />
    ));

    expect(screen.getByText('Chorus')).toBeTruthy();
    expect(document.querySelectorAll('.lyric-section')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(
      document.querySelectorAll('.lyric-performance__current'),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('.lyric-performance__context'),
    ).toHaveLength(1);

    expect(
      lyricFrameAt(timeline, 20, 20, buildLyricLinePacing(timeline)),
    ).toMatchObject({
      kind: 'section',
      section: { tag: 'chorus' },
      activeLine: { sectionIndex: 1, lineIndexInSection: 2 },
    });
  });

  test('holds timed lyrics on the section cue until vocals are released', () => {
    const timeline = parseLyricTimeline(
      {
        isLatinScript: true,
        lyricsRoman: '[Verse]\nRain falls\nWind calls\n[Chorus]\nSing home',
      },
      {
        version: 1,
        mode: 'minimax-section-asr',
        durationSeconds: 20,
        segments: [
          { start: 0, end: 10, label: 'verse' },
          { start: 10, end: 20, label: 'chorus' },
        ],
      },
    );

    render(() => (
      <LyricPerformance
        timeline={timeline}
        title="Rain Song"
        language="English"
        currentTime={4}
        duration={20}
        mode="live"
        holdLines
      />
    ));

    expect(screen.getByText('Verse')).toBeTruthy();
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    expect(screen.queryByText('Rain falls')).toBeNull();
  });

  test('auto-scrolls cumulative atmospheric lyrics as new lines appear', async () => {
    const timeline = parseLyricTimeline({
      isLatinScript: true,
      lyricsRoman:
        '[Verse]\nOne\nTwo\nThree\n[Chorus]\nFour\nFive\nSix\n[Bridge]\nSeven\nEight',
    });
    const [clock, setClock] = createSignal(0);
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });

    render(() => (
      <LyricPerformance
        timeline={timeline}
        title="Eight-line Song"
        language="English"
        currentTime={clock()}
        duration={80}
        mode="live"
      />
    ));
    await Promise.resolve();
    scrollTo.mockClear();

    setClock(79);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByRole('heading', { name: 'Bridge' })).toBeTruthy();
    expect(screen.getByText('Eight')).toBeTruthy();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  test('does not auto-scroll transcripts and honors reduced motion in live mode', async () => {
    const timeline = parseLyricTimeline({
      isLatinScript: true,
      lyricsRoman: '[Verse]\nOne\nTwo',
    });
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });

    const transcript = render(() => (
      <LyricPerformance
        timeline={timeline}
        title="Two-line Song"
        language="English"
        currentTime={20}
        duration={20}
        mode="transcript"
      />
    ));
    await Promise.resolve();
    expect(scrollTo).not.toHaveBeenCalled();
    transcript.unmount();

    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    render(() => (
      <LyricPerformance
        timeline={timeline}
        title="Two-line Song"
        language="English"
        currentTime={20}
        duration={20}
        mode="live"
      />
    ));
    await Promise.resolve();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    vi.unstubAllGlobals();
  });
});
