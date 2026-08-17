import test from 'node:test';
import assert from 'node:assert/strict';
import * as lyricSync from '../public/lyric-sync.mjs';

const {
  activeTimelineEntry,
  buildSectionTimeline,
  normalizeLyricTiming,
  parseLyricSheet
} = lyricSync;

test('exports only the four lyric synchronization functions', () => {
  assert.deepEqual(Object.keys(lyricSync).sort(), [
    'activeTimelineEntry',
    'buildSectionTimeline',
    'normalizeLyricTiming',
    'parseLyricSheet'
  ]);
});

test('parses aligned Gujarati verse and chorus lyrics without losing line identity', () => {
  const parsed = parseLyricSheet({
    isLatinScript: false,
    lyricsNative: '[Verse 1]\nઆ સાંજ ધીમે\n\n[Chorus]\nવરસાદ બોલે',
    lyricsRoman: '[verse-1]\naa saanj dhime\n[chorus]\nvarsaad bole'
  });

  assert.equal(parsed.aligned, true);
  assert.equal(parsed.lines.length, 4);
  assert.equal(parsed.sections.length, 2);
  assert.deepEqual(parsed.lines.map(line => ({
    cue: line.cue,
    tag: line.tag,
    family: line.family,
    primary: line.primary,
    secondary: line.secondary,
    sectionIndex: line.sectionIndex
  })), [
    { cue: true, tag: 'verse 1', family: 'verse', primary: '[Verse 1]', secondary: '', sectionIndex: 0 },
    { cue: false, tag: 'verse 1', family: 'verse', primary: 'આ સાંજ ધીમે', secondary: 'aa saanj dhime', sectionIndex: 0 },
    { cue: true, tag: 'chorus', family: 'chorus', primary: '[Chorus]', secondary: '', sectionIndex: 1 },
    { cue: false, tag: 'chorus', family: 'chorus', primary: 'વરસાદ બોલે', secondary: 'varsaad bole', sectionIndex: 1 }
  ]);
  assert.equal(parsed.sections[0].lines[1], parsed.lines[1]);
  assert.equal(parsed.sections[1].lines[0], parsed.lines[2]);
});

test('uses Latin lyrics once without duplicating a secondary line', () => {
  const parsed = parseLyricSheet({
    isLatinScript: true,
    lyricsNative: '[Verse]\nRain on the window',
    lyricsRoman: '[Verse]\nRain on the window'
  });

  assert.equal(parsed.aligned, true);
  assert.deepEqual(parsed.lines.map(line => line.primary), ['[Verse]', 'Rain on the window']);
  assert.deepEqual(parsed.lines.map(line => line.secondary), ['', '']);
});

test('suppresses every romanized line when a line is missing', () => {
  const parsed = parseLyricSheet({
    isLatinScript: false,
    lyricsNative: '[Verse]\nપહેલી પંક્તિ\nબીજી પંક્તિ\n[Chorus]\nધ્રુવ પંક્તિ',
    lyricsRoman: '[Verse]\npaheli pankti\n[Chorus]\ndhruv pankti'
  });

  assert.equal(parsed.aligned, false);
  assert.deepEqual(parsed.lines.map(line => line.primary), [
    '[Verse]', 'પહેલી પંક્તિ', 'બીજી પંક્તિ', '[Chorus]', 'ધ્રુવ પંક્તિ'
  ]);
  assert.ok(parsed.lines.every(line => line.secondary === ''));
});

test('suppresses every romanized line when section tags do not align', () => {
  const parsed = parseLyricSheet({
    isLatinScript: false,
    lyricsNative: '[Chorus]\nગાવું છે',
    lyricsRoman: '[Hook]\ngaavu chhe'
  });

  assert.equal(parsed.aligned, false);
  assert.deepEqual(parsed.lines.map(line => line.primary), ['[Chorus]', 'ગાવું છે']);
  assert.ok(parsed.lines.every(line => line.secondary === ''));
});

test('normalizes numbered and hyphenated tags and creates an implicit pre-tag section', () => {
  const parsed = parseLyricSheet({
    isLatinScript: false,
    lyricsNative: 'શરૂઆત\n[Pre-Chorus 2]\nઉછાળો\n[Build-up 3]\nતૈયારી\n[Mystery 4]\nઅજાણ્યું',
    lyricsRoman: 'sharuaat\n[pre chorus-2]\nuchhaalo\n[build up 3]\ntaiyaari\n[mystery-4]\najaaniyu'
  });

  assert.equal(parsed.aligned, true);
  assert.deepEqual(parsed.sections.map(section => ({
    index: section.index,
    tag: section.tag,
    family: section.family
  })), [
    { index: 0, tag: null, family: 'other' },
    { index: 1, tag: 'pre chorus 2', family: 'verse' },
    { index: 2, tag: 'build up 3', family: 'bridge' },
    { index: 3, tag: 'mystery 4', family: 'other' }
  ]);
  assert.equal(parsed.lines[0].sectionIndex, 0);
  assert.equal(parsed.lines[1].primary, '[Pre-Chorus 2]');
});

test('normalizes a valid timing artifact into newly allocated known fields', () => {
  const input = {
    version: 1,
    mode: 'minimax-section-asr',
    durationSeconds: 90,
    ignored: 'drop me',
    segments: [
      { start: 0, end: 15.5, label: 'intro', confidence: 0.9 },
      { start: 15.5, end: 45.2, label: 'verse' },
      { start: 50, end: 90, label: 'chorus' }
    ]
  };

  const normalized = normalizeLyricTiming(input);
  assert.deepEqual(normalized, {
    version: 1,
    mode: 'minimax-section-asr',
    durationSeconds: 90,
    segments: [
      { start: 0, end: 15.5, label: 'intro' },
      { start: 15.5, end: 45.2, label: 'verse' },
      { start: 50, end: 90, label: 'chorus' }
    ]
  });
  assert.notEqual(normalized, input);
  assert.notEqual(normalized.segments, input.segments);
  assert.notEqual(normalized.segments[0], input.segments[0]);
  assert.equal(input.ignored, 'drop me');
  assert.equal(input.segments[0].confidence, 0.9);
});

test('rejects malformed, overlapping, out-of-range, and oversized timing artifacts', async t => {
  const valid = {
    version: 1,
    mode: 'minimax-section-asr',
    durationSeconds: 90,
    segments: [{ start: 0, end: 10, label: 'intro' }]
  };
  const invalid = {
    'non-object': null,
    'wrong version': { ...valid, version: 2 },
    'wrong mode': { ...valid, mode: 'approximate' },
    'NaN duration': { ...valid, durationSeconds: Number.NaN },
    'zero duration': { ...valid, durationSeconds: 0 },
    'duration above six minutes': { ...valid, durationSeconds: 361 },
    'empty segments': { ...valid, segments: [] },
    'unknown label': { ...valid, segments: [{ start: 0, end: 10, label: 'hook' }] },
    'NaN boundary': { ...valid, segments: [{ start: 0, end: Number.NaN, label: 'intro' }] },
    'negative start': { ...valid, segments: [{ start: -1, end: 10, label: 'intro' }] },
    'empty interval': { ...valid, segments: [{ start: 10, end: 10, label: 'intro' }] },
    'end after duration': { ...valid, segments: [{ start: 80, end: 91, label: 'outro' }] },
    overlap: { ...valid, segments: [
      { start: 0, end: 20, label: 'intro' },
      { start: 19.9, end: 30, label: 'verse' }
    ] },
    'more than 64 segments': { ...valid, segments: Array.from({ length: 65 }, (_, index) => ({
      start: index,
      end: index + 0.5,
      label: 'verse'
    })) }
  };

  for (const [name, value] of Object.entries(invalid)) {
    await t.test(name, () => assert.equal(normalizeLyricTiming(value), null));
  }
});

test('maps repeated section families in order and preserves instrumental and silence segments', () => {
  const sections = parseLyricSheet({
    isLatinScript: true,
    lyricsNative: '[Verse]\nFirst\n[Chorus]\nHook\n[Verse 2]\nSecond\n[Inst]\nMusic\n[Chorus 2]\nFinal'
  }).sections;
  const timing = {
    version: 1,
    mode: 'minimax-section-asr',
    durationSeconds: 60,
    segments: [
      { start: 0, end: 10, label: 'verse' },
      { start: 10, end: 20, label: 'chorus' },
      { start: 20, end: 30, label: 'silence' },
      { start: 30, end: 40, label: 'verse' },
      { start: 40, end: 50, label: 'inst' },
      { start: 50, end: 60, label: 'chorus' }
    ]
  };

  assert.deepEqual(buildSectionTimeline(sections, timing), [
    { start: 0, end: 10, label: 'verse', sectionIndex: 0 },
    { start: 10, end: 20, label: 'chorus', sectionIndex: 1 },
    { start: 20, end: 30, label: 'silence', sectionIndex: null },
    { start: 30, end: 40, label: 'verse', sectionIndex: 2 },
    { start: 40, end: 50, label: 'inst', sectionIndex: 3 },
    { start: 50, end: 60, label: 'chorus', sectionIndex: 4 }
  ]);
});

test('keeps unmappable segments only when at least two and half of non-silence segments map', () => {
  const sections = parseLyricSheet({
    isLatinScript: true,
    lyricsNative: '[Verse]\nFirst\n[Chorus]\nHook'
  }).sections;
  const timing = segments => ({
    version: 1,
    mode: 'minimax-section-asr',
    durationSeconds: segments.at(-1).end,
    segments
  });

  const atHalf = buildSectionTimeline(sections, timing([
    { start: 0, end: 10, label: 'verse' },
    { start: 10, end: 20, label: 'inst' },
    { start: 20, end: 30, label: 'chorus' },
    { start: 30, end: 40, label: 'outro' },
    { start: 40, end: 50, label: 'silence' }
  ]));
  assert.deepEqual(atHalf?.map(entry => entry.sectionIndex), [0, null, 1, null, null]);

  assert.equal(buildSectionTimeline(sections, timing([
    { start: 0, end: 10, label: 'verse' },
    { start: 10, end: 20, label: 'inst' },
    { start: 20, end: 30, label: 'chorus' },
    { start: 30, end: 40, label: 'outro' },
    { start: 40, end: 50, label: 'bridge' }
  ])), null);

  assert.equal(buildSectionTimeline(sections.slice(0, 1), timing([
    { start: 0, end: 10, label: 'verse' },
    { start: 10, end: 20, label: 'outro' }
  ])), null, 'one mapped segment is insufficient even at 50%');
  assert.equal(buildSectionTimeline(sections, { version: 1 }), null);
});

test('finds active half-open timeline entries without retaining seek state', () => {
  const timeline = [
    { start: 0, end: 10, label: 'intro', sectionIndex: 0 },
    { start: 10, end: 20, label: 'verse', sectionIndex: 1 },
    { start: 25, end: 30, label: 'silence', sectionIndex: null }
  ];

  assert.equal(activeTimelineEntry(timeline, 0), timeline[0]);
  assert.equal(activeTimelineEntry(timeline, 9.999), timeline[0]);
  assert.equal(activeTimelineEntry(timeline, 10), timeline[1]);
  assert.equal(activeTimelineEntry(timeline, 20), null);
  assert.equal(activeTimelineEntry(timeline, 26), timeline[2]);
  assert.equal(activeTimelineEntry(timeline, 30), null);
  assert.equal(activeTimelineEntry(timeline, 4), timeline[0], 'a backward seek is a fresh lookup');
  assert.equal(activeTimelineEntry(timeline, -1), null);
  assert.equal(activeTimelineEntry(timeline, Number.NaN), null);
  assert.equal(activeTimelineEntry([{ ...timeline[0], end: 0 }], 0), null);
  assert.equal(activeTimelineEntry([
    { start: 0, end: 10, label: 'intro', sectionIndex: 0 },
    { start: 9, end: 12, label: 'verse', sectionIndex: 1 }
  ], 9.5), null);
});
