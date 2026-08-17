// @vitest-environment jsdom
import { render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, test } from 'vitest';

import { TimedSectionView } from '../../../src/client/host/App.tsx';
import type { PacedLine } from '../../../src/lyrics/line-pacing.ts';
import { parseLyricSheet } from '../../../src/lyrics/lyric-sync.ts';

describe('host timed lyric rendering', () => {
  test('holds sung lines through pending and pre-gate states, then reveals them at cutover', async () => {
    const section = parseLyricSheet({
      isLatinScript: true,
      lyricsNative: '',
      lyricsRoman: '[Verse]\nRain on the window\nUnder amber light',
    }).sections[0]!;
    const paced: PacedLine = {
      sectionIndex: 0,
      lineIndexInSection: 1,
      start: 0,
      end: 6,
    };
    const [gate, setGate] = createSignal<number | null | undefined>(undefined);
    const [clock, setClock] = createSignal(2);
    const held = () =>
      gate() === undefined || (gate() !== null && clock() < (gate() ?? 0));

    render(() => (
      <TimedSectionView
        section={section}
        activeLine={paced}
        holdLines={held()}
      />
    ));

    expect(screen.getByText('Verse')).toBeTruthy();
    expect(screen.queryByText('Rain on the window')).toBeNull();

    setGate(5);
    await Promise.resolve();
    expect(screen.queryByText('Rain on the window')).toBeNull();

    setClock(5);
    await Promise.resolve();
    const current = screen
      .getByText('Rain on the window')
      .closest('.lyric-line');
    expect(current?.classList.contains('lyric-line-current')).toBe(true);
    expect(current?.getAttribute('aria-current')).toBe('true');
    expect(screen.getByText('Under amber light')).toBeTruthy();
  });
});
