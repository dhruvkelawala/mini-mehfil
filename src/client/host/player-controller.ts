import { createSignal, getOwner, onCleanup } from 'solid-js';

import type { HostLyrics } from './generation-recovery.ts';
import type { MediaDiagnostics } from './media-diagnostics.ts';

export interface PlayerController {
  ready: () => boolean;
  playing: () => boolean;
  title: () => string;
  subtitle: () => string;
  bindAudio(element: HTMLAudioElement): void;
  load(source: string, lyrics: HostLyrics): Promise<void>;
  toggle(): Promise<void>;
}

function sourceUrl(source: string): { url: string; disposable: boolean } {
  if (/^https:\/\//i.test(source)) return { url: source, disposable: false };
  const hex = source.replace(/^0x/i, '');
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('The finished recording is unavailable.');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return {
    url: URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })),
    disposable: true,
  };
}

export function createPlayerController(
  diagnostics: MediaDiagnostics,
): PlayerController {
  const [ready, setReady] = createSignal(false);
  const [playing, setPlaying] = createSignal(false);
  const [title, setTitle] = createSignal('Your song will appear here');
  const [subtitle, setSubtitle] = createSignal('MiniMax Music 3');
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;

  const dispose = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
  if (getOwner()) onCleanup(dispose);

  const attemptPlay = async () => {
    if (!audio) return;
    try {
      await audio.play();
      setPlaying(true);
    } catch (error) {
      setPlaying(false);
      diagnostics.recordFailure(error);
    }
  };

  return {
    ready,
    playing,
    title,
    subtitle,
    bindAudio(element) {
      audio = element;
      element.addEventListener('play', () => setPlaying(true));
      element.addEventListener('pause', () => setPlaying(false));
    },
    async load(source, lyrics) {
      dispose();
      const resolved = sourceUrl(source);
      objectUrl = resolved.disposable ? resolved.url : null;
      if (audio) {
        audio.src = resolved.url;
        audio.load();
      }
      setTitle(lyrics.title);
      setSubtitle(lyrics.language);
      setReady(true);
      await attemptPlay();
    },
    async toggle() {
      if (!audio || !ready()) return;
      if (audio.paused) await attemptPlay();
      else audio.pause();
    },
  };
}
