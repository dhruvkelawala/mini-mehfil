// @vitest-environment jsdom
import { render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, test, vi } from 'vitest';

import { App } from '../../../src/client/listener/App.tsx';
import type {
  ListenerRoomController,
  ListenerSnapshot,
} from '../../../src/client/listener/listener-room-controller.ts';

function listenerController(
  snapshot: ListenerSnapshot | null,
): ListenerRoomController {
  const [state] = createSignal(snapshot);
  return {
    status: () => 'The host is here.',
    joined: () => snapshot !== null,
    terminal: () => false,
    snapshot: state,
    audioBlocked: () => false,
    playbackLabel: () => 'Host paused',
    bindAudio: vi.fn(),
    enableAudio: () => Promise.resolve(),
    connect: vi.fn(),
    submitRequest: vi.fn(),
    close: vi.fn(),
  };
}

describe('listener app', () => {
  test('keeps the accessible join flow', async () => {
    const controller = listenerController(null);
    render(() => <App roomId="ABCDEFGH" controller={controller} />);
    const name = screen.getByLabelText('Your name optional');
    name.setAttribute('value', 'Ada');
    screen.getByRole('button', { name: 'Join the mehfil' }).click();
    expect(controller.connect).toHaveBeenCalled();
  });

  test('renders synchronized native and romanized lyrics', () => {
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
          lyricsNative: '[Verse]\nबारिश की रात',
          lyricsRoman: '[Verse]\nBaarish ki raat',
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
  });
});
