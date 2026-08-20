import assert from 'node:assert/strict';

import { test } from 'vitest';

import { parseLyricSheet } from '../../src/lyrics/lyric-sync.ts';
import {
  storyCardHost,
  storyFileName,
  storyStanza,
} from '../../src/shared/story-card.ts';

function stanzaOf(lyrics: string): string[] {
  const sheet = parseLyricSheet({
    isLatinScript: true,
    lyricsNative: lyrics,
    lyricsRoman: lyrics,
  });
  return storyStanza(sheet.sections, sheet.lines).map((line) => line.primary);
}

test('the card quotes the chorus when the sheet names one long enough', () => {
  assert.deepEqual(
    stanzaOf(
      '[Verse]\nRain on the window\nUnder amber light\n[Chorus]\nSing it back to me\nUntil the lamps go out\nUntil the courtyard hums',
    ),
    [
      'Sing it back to me',
      'Until the lamps go out',
      'Until the courtyard hums',
    ],
  );
});

test('a chorus too short to carry the card gives way to the longest section', () => {
  assert.deepEqual(
    stanzaOf(
      '[Verse]\nRain on the window\nUnder amber light\nAnd nobody leaves\n[Chorus]\nSing it back',
    ),
    ['Rain on the window', 'Under amber light', 'And nobody leaves'],
  );
});

test('a sheet with no section cues still yields its opening lines', () => {
  assert.deepEqual(stanzaOf('Rain on the window\nUnder amber light'), [
    'Rain on the window',
    'Under amber light',
  ]);
});

test('the stanza never runs past six lines', () => {
  const long = `[Chorus]\n${Array.from(
    { length: 12 },
    (_, index) => `Line ${String(index + 1)}`,
  ).join('\n')}`;
  assert.equal(stanzaOf(long).length, 6);
});

test('an empty sheet asks the card to draw nothing rather than throwing', () => {
  assert.deepEqual(stanzaOf(''), []);
});

test('the romanization travels with the line it belongs to', () => {
  const sheet = parseLyricSheet({
    isLatinScript: false,
    lyricsNative: '[Verse]\nઆ સાંજ ધીમે',
    lyricsRoman: '[Verse]\naa saanj dhime',
  });
  assert.deepEqual(storyStanza(sheet.sections, sheet.lines), [
    { primary: 'આ સાંજ ધીમે', secondary: 'aa saanj dhime' },
  ]);
});

test('a file name keeps the title readable and loses only reserved characters', () => {
  assert.equal(storyFileName('Rain / Refrain', 'jpg'), 'Rain   Refrain.jpg');
  assert.equal(storyFileName('Aloopuri Khavsa', 'jpg'), 'Aloopuri Khavsa.jpg');
  assert.equal(storyFileName('ગીત: રાત', 'jpg'), 'ગીત  રાત.jpg');
});

test('a title of nothing but reserved characters still names a file', () => {
  assert.equal(storyFileName('///', 'jpg'), 'Mini Mehfil.jpg');
  assert.equal(storyFileName('', 'jpg'), 'Mini Mehfil.jpg');
});

test('a very long title is cut without leaving a trailing space', () => {
  const name = storyFileName('A'.repeat(40) + ' ' + 'B'.repeat(40), 'jpg');
  assert.ok(name.length <= 64, name);
  assert.doesNotMatch(name, / \.jpg$/);
});

test('the painted host comes from the origin, and never throws on a bad one', () => {
  assert.equal(
    storyCardHost('https://minimehfil.wtf/s/AbCd'),
    'minimehfil.wtf',
  );
  assert.equal(storyCardHost('http://localhost:4173'), 'localhost:4173');
  assert.equal(storyCardHost('not a url'), 'minimehfil.wtf');
  assert.equal(storyCardHost(''), 'minimehfil.wtf');
});
