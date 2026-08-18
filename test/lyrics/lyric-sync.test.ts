import { describe, expect, test } from 'vitest';

import * as lyricSync from '../../src/lyrics/lyric-sync.ts';
import {
  activeTimelineEntry,
  buildSectionTimeline,
  normalizeLyricTiming,
  parseLyricSheet,
  type LyricTiming,
  type LyricTimingSegment,
  type TimelineEntry,
} from '../../src/lyrics/lyric-sync.ts';

/**
 * The host app's original reveal parser, copied verbatim from the `lyricLines`
 * memo it replaces. `parseLyricSheet` must agree with it line for line so the
 * untimed reveal keeps rendering exactly what it renders today.
 */
function originalHostLyricLines(sheet: {
  isLatinScript: boolean;
  lyricsNative: string;
  lyricsRoman: string;
}) {
  const roman = sheet.lyricsRoman.split('\n').filter((line) => line.trim());
  const native = sheet.lyricsNative.split('\n').filter((line) => line.trim());
  const useNative = !sheet.isLatinScript && native.length > 0;
  return (useNative ? native : roman).map((primary, index) => {
    const romanLine = roman[index] ?? '';
    const cue = /^\[.+\]$/.test(romanLine || primary);
    return {
      cue,
      primary: cue
        ? (romanLine || primary).replace(/^\[(.+)\]$/, '$1')
        : primary,
      secondary: useNative && !cue && romanLine !== primary ? romanLine : '',
    };
  });
}

const timingOf = (segments: LyricTimingSegment[]): LyricTiming => ({
  version: 1,
  mode: 'minimax-section-asr',
  durationSeconds: segments.at(-1)?.end ?? 1,
  segments,
});

describe('lyric sheet parsing', () => {
  test('exports only the four lyric synchronization functions', () => {
    expect(Object.keys(lyricSync).sort()).toEqual([
      'activeTimelineEntry',
      'buildSectionTimeline',
      'normalizeLyricTiming',
      'parseLyricSheet',
    ]);
  });

  test('parses Gujarati verse and chorus lyrics without losing line identity', () => {
    const parsed = parseLyricSheet({
      isLatinScript: false,
      lyricsNative: '[Verse 1]\nઆ સાંજ ધીમે\n\n[Chorus]\nવરસાદ બોલે',
      lyricsRoman: '[verse-1]\naa saanj dhime\n[chorus]\nvarsaad bole',
    });

    expect(parsed.lines).toEqual([
      {
        cue: true,
        tag: 'verse 1',
        family: 'verse',
        primary: 'verse-1',
        secondary: '',
        sectionIndex: 0,
      },
      {
        cue: false,
        tag: 'verse 1',
        family: 'verse',
        primary: 'આ સાંજ ધીમે',
        secondary: 'aa saanj dhime',
        sectionIndex: 0,
      },
      {
        cue: true,
        tag: 'chorus',
        family: 'chorus',
        primary: 'chorus',
        secondary: '',
        sectionIndex: 1,
      },
      {
        cue: false,
        tag: 'chorus',
        family: 'chorus',
        primary: 'વરસાદ બોલે',
        secondary: 'varsaad bole',
        sectionIndex: 1,
      },
    ]);
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]?.lines[1]).toBe(parsed.lines[1]);
    expect(parsed.sections[1]?.lines[0]).toBe(parsed.lines[2]);
  });

  test('uses Latin lyrics once without duplicating a secondary line', () => {
    const parsed = parseLyricSheet({
      isLatinScript: true,
      lyricsNative: '[Verse]\nRain on the window',
      lyricsRoman: '[Verse]\nRain on the window',
    });

    expect(parsed.lines.map((line) => line.primary)).toEqual([
      'Verse',
      'Rain on the window',
    ]);
    expect(parsed.lines.every((line) => line.secondary === '')).toBe(true);
  });

  test('reads cues from the romanized sheet first, matching the host reveal', () => {
    const sheets = [
      {
        isLatinScript: false,
        lyricsNative: '[Verse 1]\nઆ સાંજ ધીમે\n\n[Chorus]\nવરસાદ બોલે',
        lyricsRoman: '[verse-1]\naa saanj dhime\n[chorus]\nvarsaad bole',
      },
      {
        isLatinScript: true,
        lyricsNative: '[Verse]\nRain on the window\n[Chorus]\nSing it back',
        lyricsRoman: '[Verse]\nRain on the window\n[Chorus]\nSing it back',
      },
      {
        isLatinScript: false,
        lyricsNative: '',
        lyricsRoman: 'sharuaat\n[chorus]\nvarsaad bole',
      },
    ];

    for (const sheet of sheets) {
      expect(
        parseLyricSheet(sheet).lines.map((line) => ({
          cue: line.cue,
          primary: line.primary,
          secondary: line.secondary,
        })),
      ).toEqual(originalHostLyricLines(sheet));
    }
  });

  test('normalizes numbered and hyphenated tags and creates an implicit pre-tag section', () => {
    const parsed = parseLyricSheet({
      isLatinScript: false,
      lyricsNative:
        'શરૂઆત\n[Pre-Chorus 2]\nઉછાળો\n[Build-up 3]\nતૈયારી\n[Mystery 4]\nઅજાણ્યું',
      lyricsRoman:
        'sharuaat\n[pre chorus-2]\nuchhaalo\n[build up 3]\ntaiyaari\n[mystery-4]\najaaniyu',
    });

    expect(
      parsed.sections.map((section) => ({
        index: section.index,
        tag: section.tag,
        family: section.family,
      })),
    ).toEqual([
      { index: 0, tag: null, family: 'other' },
      { index: 1, tag: 'pre chorus 2', family: 'verse' },
      { index: 2, tag: 'build up 3', family: 'bridge' },
      { index: 3, tag: 'mystery 4', family: 'other' },
    ]);
    expect(parsed.lines[0]?.sectionIndex).toBe(0);
    expect(parsed.lines[1]?.primary).toBe('pre chorus-2');
  });

  test('returns an empty sheet for values that are not lyric sheets', () => {
    for (const value of [null, undefined, 'lyrics', 42, []])
      expect(parseLyricSheet(value)).toEqual({ lines: [], sections: [] });
  });
});

describe('timing artifact validation', () => {
  test('normalizes a valid timing artifact into newly allocated known fields', () => {
    const input = {
      version: 1,
      mode: 'minimax-section-asr',
      durationSeconds: 90,
      ignored: 'drop me',
      segments: [
        { start: 0, end: 15.5, label: 'intro', confidence: 0.9 },
        { start: 15.5, end: 45.2, label: 'verse' },
        { start: 50, end: 90, label: 'chorus' },
      ],
    };

    const normalized = normalizeLyricTiming(input);
    expect(normalized).toEqual({
      version: 1,
      mode: 'minimax-section-asr',
      durationSeconds: 90,
      segments: [
        { start: 0, end: 15.5, label: 'intro' },
        { start: 15.5, end: 45.2, label: 'verse' },
        { start: 50, end: 90, label: 'chorus' },
      ],
    });
    expect(normalized).not.toBe(input);
    expect(normalized?.segments).not.toBe(input.segments);
    expect(normalized?.segments[0]).not.toBe(input.segments[0]);
    expect(input.ignored).toBe('drop me');
    expect(input.segments[0]?.confidence).toBe(0.9);
  });

  test('clamps a final boundary that overshoots the duration within one second', () => {
    // Real provider output from the 2026-08-17 20:49 generation: MiniMax
    // rounds segment boundaries but reports the exact duration, so its own
    // final boundary can land past its own duration by a few milliseconds.
    const durationSeconds = 126.72290249433107;
    const normalized = normalizeLyricTiming({
      version: 1,
      mode: 'minimax-section-asr',
      durationSeconds,
      segments: [
        { start: 0, end: 9, label: 'intro' },
        { start: 9, end: 125.645, label: 'verse' },
        { start: 125.645, end: 126.725, label: 'silence' },
      ],
    });
    expect(normalized).not.toBeNull();
    expect(normalized?.segments[2]).toEqual({
      start: 125.645,
      end: durationSeconds,
      label: 'silence',
    });
  });

  test('clamps an overshoot of exactly one second', () => {
    const normalized = normalizeLyricTiming({
      version: 1,
      mode: 'minimax-section-asr',
      durationSeconds: 90,
      segments: [{ start: 80, end: 91, label: 'outro' }],
    });
    expect(normalized?.segments[0]).toEqual({
      start: 80,
      end: 90,
      label: 'outro',
    });
  });

  test('clamped artifacts re-normalize to the same value', () => {
    const first = normalizeLyricTiming({
      version: 1,
      mode: 'minimax-section-asr',
      durationSeconds: 126.72290249433107,
      segments: [{ start: 0, end: 126.725, label: 'verse' }],
    });
    expect(first).not.toBeNull();
    expect(normalizeLyricTiming(first)).toEqual(first);
  });

  const valid = {
    version: 1,
    mode: 'minimax-section-asr',
    durationSeconds: 90,
    segments: [{ start: 0, end: 10, label: 'intro' }],
  };
  const invalid: Record<string, unknown> = {
    'non-object': null,
    'array input': [],
    'wrong version': { ...valid, version: 2 },
    'wrong mode': { ...valid, mode: 'approximate' },
    'NaN duration': { ...valid, durationSeconds: Number.NaN },
    'zero duration': { ...valid, durationSeconds: 0 },
    'duration above six minutes': { ...valid, durationSeconds: 361 },
    'empty segments': { ...valid, segments: [] },
    'segments not an array': { ...valid, segments: {} },
    'non-object segment': { ...valid, segments: [null] },
    'unknown label': {
      ...valid,
      segments: [{ start: 0, end: 10, label: 'hook' }],
    },
    'NaN boundary': {
      ...valid,
      segments: [{ start: 0, end: Number.NaN, label: 'intro' }],
    },
    'negative start': {
      ...valid,
      segments: [{ start: -1, end: 10, label: 'intro' }],
    },
    'empty interval': {
      ...valid,
      segments: [{ start: 10, end: 10, label: 'intro' }],
    },
    'end more than a second after duration': {
      ...valid,
      segments: [{ start: 80, end: 91.001, label: 'outro' }],
    },
    'start at or past the clamped duration': {
      ...valid,
      segments: [{ start: 90, end: 90.5, label: 'outro' }],
    },
    overlap: {
      ...valid,
      segments: [
        { start: 0, end: 20, label: 'intro' },
        { start: 19.9, end: 30, label: 'verse' },
      ],
    },
    'more than 64 segments': {
      ...valid,
      segments: Array.from({ length: 65 }, (_, index) => ({
        start: index,
        end: index + 0.5,
        label: 'verse',
      })),
    },
  };

  test.each(Object.keys(invalid))('rejects %s', (name) => {
    expect(normalizeLyricTiming(invalid[name])).toBeNull();
  });
});

describe('section timeline mapping', () => {
  const sections = (lyrics: string) =>
    parseLyricSheet({
      isLatinScript: true,
      lyricsNative: lyrics,
      lyricsRoman: lyrics,
    }).sections;

  test('maps repeated section families in order and preserves instrumental and silence segments', () => {
    const parsed = sections(
      '[Verse]\nFirst\n[Chorus]\nHook\n[Verse 2]\nSecond\n[Inst]\nMusic\n[Chorus 2]\nFinal',
    );

    expect(
      buildSectionTimeline(
        parsed,
        timingOf([
          { start: 0, end: 10, label: 'verse' },
          { start: 10, end: 20, label: 'chorus' },
          { start: 20, end: 30, label: 'silence' },
          { start: 30, end: 40, label: 'verse' },
          { start: 40, end: 50, label: 'inst' },
          { start: 50, end: 60, label: 'chorus' },
        ]),
      ),
    ).toEqual([
      { start: 0, end: 10, label: 'verse', sectionIndex: 0 },
      { start: 10, end: 20, label: 'chorus', sectionIndex: 1 },
      { start: 20, end: 30, label: 'silence', sectionIndex: null },
      { start: 30, end: 40, label: 'verse', sectionIndex: 2 },
      { start: 40, end: 50, label: 'inst', sectionIndex: 3 },
      { start: 50, end: 60, label: 'chorus', sectionIndex: 4 },
    ]);
  });

  test('aligns provider repeats without skipping written sections', () => {
    // Real structure from the 2026-08-18 "room song goes silent mid-way"
    // incident: the provider heard five choruses and two bridges where the
    // sheet wrote two choruses and one bridge, and the old greedy cursor
    // matched the second chorus against the final written chorus, mapping
    // nothing between 97 s and 174 s.
    const parsed = sections(
      [
        '[Intro]',
        'Open',
        '[Verse]',
        'One',
        '[Pre Chorus]',
        'Rise',
        '[Chorus]',
        'Hook',
        '[Verse 2]',
        'Two',
        '[Pre Chorus 2]',
        'Rise again',
        '[Chorus 2]',
        'Hook again',
        '[Bridge]',
        'Turn',
        '[Outro]',
        'Close',
      ].join('\n'),
    );

    const timeline = buildSectionTimeline(
      parsed,
      timingOf([
        { start: 0, end: 23.521, label: 'intro' },
        { start: 23.521, end: 48.122, label: 'verse' },
        { start: 48.122, end: 72.603, label: 'verse' },
        { start: 72.603, end: 84.603, label: 'chorus' },
        { start: 84.603, end: 97.324, label: 'chorus' },
        { start: 97.324, end: 121.925, label: 'verse' },
        { start: 121.925, end: 146.526, label: 'verse' },
        { start: 146.526, end: 159.006, label: 'chorus' },
        { start: 159.006, end: 174.367, label: 'chorus' },
        { start: 174.367, end: 186.487, label: 'bridge' },
        { start: 186.487, end: 198.848, label: 'bridge' },
        { start: 198.848, end: 211.568, label: 'chorus' },
        { start: 211.568, end: 232.689, label: 'outro' },
        { start: 232.689, end: 235.067, label: 'silence' },
      ]),
    );

    expect(timeline?.map((entry) => entry.sectionIndex)).toEqual([
      0, // intro
      1, // verse
      2, // pre chorus sung as a verse family
      3, // chorus
      3, // provider split the same chorus into a second segment
      4, // verse 2
      5, // pre chorus 2
      6, // chorus 2
      6, // repeated chorus 2
      7, // bridge
      7, // repeated bridge
      6, // final repeated chorus
      8, // outro
      null, // silence
    ]);
  });

  test('a leading repeat inherits the section it repeats from ahead', () => {
    const parsed = sections('[Verse]\nOne\n[Chorus]\nHook');
    const timeline = buildSectionTimeline(
      parsed,
      timingOf([
        { start: 0, end: 10, label: 'chorus' },
        { start: 10, end: 20, label: 'verse' },
        { start: 20, end: 30, label: 'chorus' },
      ]),
    );
    expect(timeline?.map((entry) => entry.sectionIndex)).toEqual([1, 0, 1]);
  });

  test('keeps unmappable segments only when at least two and half of non-silence segments map', () => {
    const parsed = sections('[Verse]\nFirst\n[Chorus]\nHook');

    const atHalf = buildSectionTimeline(
      parsed,
      timingOf([
        { start: 0, end: 10, label: 'verse' },
        { start: 10, end: 20, label: 'inst' },
        { start: 20, end: 30, label: 'chorus' },
        { start: 30, end: 40, label: 'outro' },
        { start: 40, end: 50, label: 'silence' },
      ]),
    );
    expect(atHalf?.map((entry) => entry.sectionIndex)).toEqual([
      0,
      null,
      1,
      null,
      null,
    ]);

    expect(
      buildSectionTimeline(
        parsed,
        timingOf([
          { start: 0, end: 10, label: 'verse' },
          { start: 10, end: 20, label: 'inst' },
          { start: 20, end: 30, label: 'chorus' },
          { start: 30, end: 40, label: 'outro' },
          { start: 40, end: 50, label: 'bridge' },
        ]),
      ),
    ).toBeNull();

    expect(
      buildSectionTimeline(
        parsed.slice(0, 1),
        timingOf([
          { start: 0, end: 10, label: 'verse' },
          { start: 10, end: 20, label: 'outro' },
        ]),
      ),
    ).toBeNull();
  });

  test('rejects malformed timing and malformed sections', () => {
    const parsed = sections('[Verse]\nFirst\n[Chorus]\nHook');
    expect(buildSectionTimeline(parsed, { version: 1 })).toBeNull();
    expect(buildSectionTimeline(parsed, null)).toBeNull();
    expect(
      buildSectionTimeline(
        'not sections',
        timingOf([{ start: 0, end: 10, label: 'verse' }]),
      ),
    ).toBeNull();
    expect(
      buildSectionTimeline(
        [{ index: -1, family: 'verse' }],
        timingOf([{ start: 0, end: 10, label: 'verse' }]),
      ),
    ).toBeNull();
  });
});

describe('active timeline lookup', () => {
  const timeline: TimelineEntry[] = [
    { start: 0, end: 10, label: 'intro', sectionIndex: 0 },
    { start: 10, end: 20, label: 'verse', sectionIndex: 1 },
    { start: 25, end: 30, label: 'silence', sectionIndex: null },
  ];

  test('finds active half-open timeline entries without retaining seek state', () => {
    expect(activeTimelineEntry(timeline, 0)).toBe(timeline[0]);
    expect(activeTimelineEntry(timeline, 9.999)).toBe(timeline[0]);
    expect(activeTimelineEntry(timeline, 10)).toBe(timeline[1]);
    expect(activeTimelineEntry(timeline, 20)).toBeNull();
    expect(activeTimelineEntry(timeline, 26)).toBe(timeline[2]);
    expect(activeTimelineEntry(timeline, 30)).toBeNull();
    expect(activeTimelineEntry(timeline, 4)).toBe(timeline[0]);
  });

  test('rejects impossible clocks and malformed timelines', () => {
    expect(activeTimelineEntry(timeline, -1)).toBeNull();
    expect(activeTimelineEntry(timeline, Number.NaN)).toBeNull();
    expect(activeTimelineEntry([], 1)).toBeNull();
    expect(activeTimelineEntry('nope', 1)).toBeNull();
    expect(
      activeTimelineEntry([{ ...timeline[0], end: 0 }] as TimelineEntry[], 0),
    ).toBeNull();
    expect(
      activeTimelineEntry(
        [
          { start: 0, end: 10, label: 'intro', sectionIndex: 0 },
          { start: 9, end: 12, label: 'verse', sectionIndex: 1 },
        ],
        9.5,
      ),
    ).toBeNull();
  });
});
