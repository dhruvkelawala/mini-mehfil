// @vitest-environment jsdom
import { cleanup, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { App } from '../../../src/client/listener/App.tsx';
import {
  activePacedLine,
  buildLinePacing,
} from '../../../src/lyrics/line-pacing.ts';
import {
  buildSectionTimeline,
  parseLyricSheet,
} from '../../../src/lyrics/lyric-sync.ts';
import type {
  ListenerRoomController,
  ListenerSnapshot,
} from '../../../src/client/listener/listener-room-controller.ts';

afterEach(cleanup);

function listenerController(
  snapshot: ListenerSnapshot | null,
  connect = vi.fn(),
): ListenerRoomController {
  const [state] = createSignal(snapshot);
  return {
    status: () => 'The host is here.',
    joined: () => snapshot !== null,
    terminal: () => false,
    snapshot: state,
    audioBlocked: () => false,
    playbackLabel: () => 'Host paused',
    currentTime: () => 0,
    duration: () => 0,
    playing: () => false,
    timing: () => snapshot?.currentSong?.lyricTiming ?? null,
    bindAudio: vi.fn(),
    enableAudio: () => Promise.resolve(),
    connect,
    submitRequest: vi.fn(),
    close: vi.fn(),
  };
}

describe('listener app', () => {
  test('keeps the accessible join flow', () => {
    const connect = vi.fn();
    const controller = listenerController(null, connect);
    render(() => <App roomId="ABCDEFGH" controller={controller} />);
    const name = screen.getByLabelText('Your name optional');
    name.setAttribute('value', 'Ada');
    screen.getByRole('button', { name: 'Join the mehfil' }).click();
    expect(connect).toHaveBeenCalled();
  });

  test('defaults song-request language to auto-detect even with English first in the dropdown', () => {
    const snapshot: ListenerSnapshot = {
      hostPresent: true,
      listenerCount: 1,
      queue: [],
      currentRecording: null,
      currentSong: {
        shareId: 'song-reference',
        title: 'Monsoon Song',
        language: 'Hindi',
        playback: { status: 'paused', positionMs: 0, changedAt: 1 },
        lyrics: {
          title: 'Monsoon Song',
          language: 'Hindi',
          nativeScriptName: 'Devanagari',
          isLatinScript: false,
          lyricsNative: '[Chorus]\nबारिश की रात',
          lyricsRoman: '[Chorus]\nBaarish ki raat',
        },
      },
      setlist: [],
    };
    const submitRequest = vi.fn();
    const controller = { ...listenerController(snapshot), submitRequest };
    const { container } = render(() => (
      <App roomId="ABCDEFGH" controller={controller} />
    ));
    const menu = container.querySelector<HTMLDetailsElement>('.room-menu');
    expect(menu).not.toBeNull();
    menu!.open = true;
    const select = screen.getByLabelText<HTMLSelectElement>('Language');
    expect(select.value).toBe('auto');
    const idea = screen.getByLabelText<HTMLTextAreaElement>(
      "What's the song about?",
    );
    idea.value = 'chai at a railway station';
    screen.getByRole('button', { name: 'Send request' }).click();
    expect(submitRequest).toHaveBeenCalledWith({
      idea: 'chai at a railway station',
      vibe: '',
      language: 'auto',
    });
  });

  test('renders one untimed primary line', () => {
    const controller = listenerController({
      hostPresent: true,
      listenerCount: 1,
      queue: [],
      currentRecording: null,
      currentSong: {
        shareId: 'song-reference',
        title: 'Monsoon Song',
        language: 'Hindi',
        playback: { status: 'paused', positionMs: 0, changedAt: 1 },
        lyrics: {
          title: 'Monsoon Song',
          language: 'Hindi',
          nativeScriptName: 'Devanagari',
          isLatinScript: false,
          lyricsNative: '[Pre-Chorus 2]\nबारिश की रात',
          lyricsRoman: '[Pre-Chorus 2]\nBaarish ki raat',
        },
      },
      setlist: [],
    });
    render(() => <App roomId="ABCDEFGH" controller={controller} />);
    expect(
      screen.getAllByRole('heading', { name: 'Monsoon Song' }),
    ).toHaveLength(2);
    expect(screen.getByText('बारिश की रात')).toBeTruthy();
    expect(screen.getByText('Baarish ki raat')).toBeTruthy();
    expect(screen.getByText('Pre-Chorus 2')).toBeTruthy();
    expect(
      document.querySelectorAll('.lyric-stage > .lyric-primary'),
    ).toHaveLength(1);
  });

  test('uses the host timeline and line rules through forward and backward seeks', async () => {
    const timing = {
      version: 1 as const,
      mode: 'minimax-section-asr' as const,
      durationSeconds: 20,
      segments: [
        { start: 0, end: 10, label: 'verse' as const },
        { start: 10, end: 20, label: 'chorus' as const },
      ],
    };
    const lyrics = {
      title: 'Monsoon Song',
      language: 'Hindi',
      nativeScriptName: 'Devanagari',
      isLatinScript: false,
      lyricsNative:
        '[Verse]\nबारिश की रात\nधीमी हवा\n[Chorus]\nफिर से गा\nदिल जगा',
      lyricsRoman:
        '[Verse]\nBaarish ki raat\nDheemi hawa\n[Chorus]\nPhir se gaa\nDil jagaa',
    };
    const snapshot: ListenerSnapshot = {
      hostPresent: true,
      listenerCount: 1,
      queue: [],
      currentRecording: null,
      currentSong: {
        shareId: 'song-reference',
        title: lyrics.title,
        language: lyrics.language,
        playback: { status: 'playing', positionMs: 0, changedAt: 1 },
        lyrics,
        lyricTiming: timing,
      },
      setlist: [],
    };
    const [clock, setClock] = createSignal(6);
    const controller = {
      ...listenerController(snapshot),
      currentTime: clock,
      duration: () => 20,
    } satisfies ListenerRoomController;
    const parsed = parseLyricSheet(lyrics);
    const timeline = buildSectionTimeline(parsed.sections, timing);
    const expectedAt = (time: number) => {
      const paced = activePacedLine(
        buildLinePacing(parsed.sections, timeline, null),
        time,
      );
      return paced
        ? parsed.sections
            .find((section) => section.index === paced.sectionIndex)
            ?.lines.at(paced.lineIndexInSection)?.primary
        : undefined;
    };

    render(() => <App roomId="ABCDEFGH" controller={controller} />);
    expect(document.querySelectorAll('.lyric-section')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(
      document.querySelector('[aria-current="true"] .lyric-primary')
        ?.textContent,
    ).toBe(expectedAt(6));

    setClock(16);
    await Promise.resolve();
    expect(document.querySelectorAll('.lyric-section')).toHaveLength(1);
    expect(
      document.querySelector('[aria-current="true"] .lyric-primary')
        ?.textContent,
    ).toBe(expectedAt(16));

    setClock(6);
    await Promise.resolve();
    expect(
      document.querySelector('[aria-current="true"] .lyric-primary')
        ?.textContent,
    ).toBe(expectedAt(6));
  });
});
