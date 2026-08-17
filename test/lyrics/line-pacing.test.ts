import { describe, expect, test } from 'vitest';

import {
  activePacedLine,
  buildLinePacing,
  syllableWeight,
  type PacedLine,
} from '../../src/lyrics/line-pacing.ts';
import {
  parseLyricSheet,
  type LyricSection,
  type TimelineEntry,
} from '../../src/lyrics/lyric-sync.ts';

const sheet = (lyricsNative: string, lyricsRoman = lyricsNative) =>
  parseLyricSheet({
    isLatinScript: lyricsNative === lyricsRoman,
    lyricsNative,
    lyricsRoman,
  });

describe('syllable weighting', () => {
  test('counts vowel groups with a minimum of one per word', () => {
    expect(syllableWeight('banana papaya')).toBe(6);
    expect(syllableWeight('soft rain')).toBe(2);
    expect(syllableWeight('rhythm & blues')).toBe(3);
  });

  test('recognizes the supported accented roman vowels', () => {
    expect(syllableWeight('ā ē ä ö ī ō ū ü')).toBe(8);
  });

  test('returns zero for empty or whitespace input', () => {
    expect(syllableWeight('')).toBe(0);
    expect(syllableWeight('  \n\t ')).toBe(0);
  });
});

describe('line pacing', () => {
  test('distributes a section proportionally using romanized lines', () => {
    const parsed = sheet(
      '[Verse]\nપહેલી\nબીજી',
      '[Verse]\nbanana papaya\nsoft rain',
    );
    const timeline: TimelineEntry[] = [
      { start: 4, end: 12, label: 'verse', sectionIndex: 0 },
    ];

    expect(buildLinePacing(parsed.sections, timeline)).toEqual([
      { sectionIndex: 0, lineIndexInSection: 1, start: 4, end: 10 },
      { sectionIndex: 0, lineIndexInSection: 2, start: 10, end: 12 },
    ]);
  });

  test('falls back to the primary line for Latin songs', () => {
    const parsed = sheet('[Verse]\nbanana papaya\nsoft rain');
    expect(
      buildLinePacing(parsed.sections, [
        { start: 0, end: 8, label: 'verse', sectionIndex: 0 },
      ]),
    ).toEqual([
      { sectionIndex: 0, lineIndexInSection: 1, start: 0, end: 6 },
      { sectionIndex: 0, lineIndexInSection: 2, start: 6, end: 8 },
    ]);
  });

  test('uses an even split when every spoken line has zero weight', () => {
    const sections: LyricSection[] = [
      {
        index: 2,
        tag: 'verse',
        family: 'verse',
        lines: ['', '', ''].map((primary) => ({
          cue: false,
          tag: 'verse',
          family: 'verse',
          primary,
          secondary: '',
          sectionIndex: 2,
        })),
      },
    ];

    expect(
      buildLinePacing(sections, [
        { start: 3, end: 12, label: 'verse', sectionIndex: 2 },
      ]),
    ).toEqual([
      { sectionIndex: 2, lineIndexInSection: 0, start: 3, end: 6 },
      { sectionIndex: 2, lineIndexInSection: 1, start: 6, end: 9 },
      { sectionIndex: 2, lineIndexInSection: 2, start: 9, end: 12 },
    ]);
  });

  test('skips cue lines and unmapped segments', () => {
    const parsed = sheet('[Verse]\nOne line\n[Chorus]\nSing again');
    const pacing = buildLinePacing(parsed.sections, [
      { start: 0, end: 4, label: 'inst', sectionIndex: null },
      { start: 4, end: 10, label: 'verse', sectionIndex: 0 },
      { start: 10, end: 16, label: 'chorus', sectionIndex: 1 },
    ]);

    expect(pacing.map((entry) => entry.lineIndexInSection)).toEqual([1, 1]);
    expect(pacing.map(({ start, end }) => [start, end])).toEqual([
      [4, 10],
      [10, 16],
    ]);
  });

  test('keeps intervals contiguous within segments and monotonic overall', () => {
    const parsed = sheet(
      '[Verse]\nFirst line\nSecond longer line\nThird\n[Chorus]\nA hook\nAgain',
    );
    const pacing = buildLinePacing(parsed.sections, [
      { start: 2, end: 13, label: 'verse', sectionIndex: 0 },
      { start: 15, end: 23, label: 'chorus', sectionIndex: 1 },
    ]);

    expect(pacing[0]?.start).toBe(2);
    expect(pacing[2]?.end).toBe(13);
    expect(pacing[3]?.start).toBe(15);
    expect(pacing.at(-1)?.end).toBe(23);
    expect(pacing[0]?.end).toBe(pacing[1]?.start);
    expect(pacing[1]?.end).toBe(pacing[2]?.start);
    expect(pacing[3]?.end).toBe(pacing[4]?.start);
    expect(
      pacing.every((entry, index) =>
        index === 0 ? true : entry.start >= (pacing[index - 1]?.end ?? 0),
      ),
    ).toBe(true);
  });
});

describe('active paced-line selection', () => {
  const pacing: PacedLine[] = [
    { sectionIndex: 0, lineIndexInSection: 1, start: 2, end: 5 },
    { sectionIndex: 0, lineIndexInSection: 2, start: 5, end: 8 },
    { sectionIndex: 1, lineIndexInSection: 1, start: 10, end: 14 },
  ];

  test('uses half-open boundaries and returns null in gaps', () => {
    expect(activePacedLine(pacing, 2)?.lineIndexInSection).toBe(1);
    expect(activePacedLine(pacing, 5)?.lineIndexInSection).toBe(2);
    expect(activePacedLine(pacing, 8)).toBeNull();
    expect(activePacedLine(pacing, 9)).toBeNull();
    expect(activePacedLine(pacing, 14)).toBeNull();
  });

  test('selects statelessly after a backward seek', () => {
    expect(activePacedLine(pacing, 12)?.sectionIndex).toBe(1);
    expect(activePacedLine(pacing, 3)?.lineIndexInSection).toBe(1);
  });

  test('returns null for invalid clocks or absent pacing', () => {
    expect(activePacedLine(pacing, Number.NaN)).toBeNull();
    expect(activePacedLine(pacing, -1)).toBeNull();
    expect(activePacedLine(null, 3)).toBeNull();
  });
});
