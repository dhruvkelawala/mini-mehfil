import { createSignal, getOwner, onCleanup } from 'solid-js';

import {
  normalizeLyricTiming,
  type LyricTiming,
} from '../../lyrics/lyric-sync.ts';
import type { RoomSong } from '../../room/protocol.ts';
import type { HostLyrics } from './generation-recovery.ts';
import type { MediaDiagnostics } from './media-diagnostics.ts';

export interface PlayerController {
  ready: () => boolean;
  playing: () => boolean;
  ended: () => boolean;
  title: () => string;
  subtitle: () => string;
  duration: () => number;
  currentTime: () => number;
  source: () => string;
  /** Decoded generation payload bytes, present only for the inline-hex path. */
  analysisBytes: () => ArrayBuffer | null;
  shareReference: () => string | null;
  /**
   * Section timing for the loaded recording, or `null` until the media element
   * has confirmed its own duration agrees with the artifact's.
   */
  timing: () => LyricTiming | null;
  bindAudio(element: HTMLAudioElement): void;
  load(
    source: string,
    lyrics: HostLyrics,
    reference?: string | null,
    timing?: unknown,
  ): Promise<void>;
  loadRoomSong(song: RoomSong, origin: string): void;
  syncRoomSong(song: RoomSong): void;
  clear(): void;
  play(): Promise<boolean>;
  pause(): void;
  toggle(): Promise<void>;
  seek(percent: number): void;
  replay(): Promise<void>;
}

function sourceUrl(source: string): {
  url: string;
  disposable: boolean;
  bytes: ArrayBuffer | null;
} {
  if (/^https:\/\//i.test(source))
    return { url: source, disposable: false, bytes: null };
  const hex = source.replace(/^0x/i, '');
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex))
    throw new Error('The finished recording is unavailable.');
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return {
    url: URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })),
    disposable: true,
    bytes: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  };
}

export function createPlayerController(
  diagnostics: MediaDiagnostics,
): PlayerController {
  const [ready, setReady] = createSignal(false);
  const [playing, setPlaying] = createSignal(false);
  const [ended, setEnded] = createSignal(false);
  const [title, setTitle] = createSignal('Your song will appear here');
  const [subtitle, setSubtitle] = createSignal('MiniMax Music 3');
  const [duration, setDuration] = createSignal(0);
  const [currentTime, setCurrentTime] = createSignal(0);
  const [source, setSource] = createSignal('');
  const [analysisBytes, setAnalysisBytes] = createSignal<ArrayBuffer | null>(
    null,
  );
  const [shareReference, setShareReference] = createSignal<string | null>(null);
  const [loadedTiming, setLoadedTiming] = createSignal<LyricTiming | null>(
    null,
  );
  const [timingMatchesMedia, setTimingMatchesMedia] = createSignal(false);
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;
  let roomTimer: ReturnType<typeof setTimeout> | null = null;
  let roomRevision = '';
  let roomMetadataHandler: (() => void) | null = null;

  const releaseObjectUrl = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };
  const dispose = () => {
    releaseObjectUrl();
    if (roomTimer) clearTimeout(roomTimer);
    if (audio && roomMetadataHandler)
      audio.removeEventListener('loadedmetadata', roomMetadataHandler);
  };
  if (getOwner()) onCleanup(dispose);

  const play = async (): Promise<boolean> => {
    if (!audio || !ready()) return false;
    try {
      await audio.play();
      setPlaying(true);
      return true;
    } catch (error) {
      setPlaying(false);
      diagnostics.recordFailure(error, audio);
      return false;
    }
  };
  /**
   * Section timings describe one specific recording. If the media element
   * reports a materially different length, the file is not the one that was
   * analyzed, so the timeline is discarded rather than stretched onto it.
   */
  const matchTimingToMedia = (mediaDuration: number) => {
    const timing = loadedTiming();
    if (!timing || !Number.isFinite(mediaDuration) || mediaDuration <= 0)
      return setTimingMatchesMedia(false);
    const tolerance = Math.max(1, mediaDuration * 0.02);
    return setTimingMatchesMedia(
      Math.abs(timing.durationSeconds - mediaDuration) <= tolerance,
    );
  };
  const clear = () => {
    releaseObjectUrl();
    if (roomTimer) clearTimeout(roomTimer);
    roomTimer = null;
    roomRevision = '';
    if (audio && roomMetadataHandler)
      audio.removeEventListener('loadedmetadata', roomMetadataHandler);
    roomMetadataHandler = null;
    audio?.pause();
    audio?.removeAttribute('src');
    audio?.load();
    setReady(false);
    setPlaying(false);
    setEnded(false);
    setDuration(0);
    setCurrentTime(0);
    setSource('');
    setAnalysisBytes(null);
    setShareReference(null);
    setLoadedTiming(null);
    setTimingMatchesMedia(false);
    setTitle('Your song will appear here');
    setSubtitle('MiniMax Music 3');
  };

  return {
    ready,
    playing,
    ended,
    title,
    subtitle,
    duration,
    currentTime,
    source,
    analysisBytes,
    shareReference,
    timing: () => (timingMatchesMedia() ? loadedTiming() : null),
    bindAudio(element) {
      audio = element;
      element.addEventListener('play', () => {
        setPlaying(true);
        setEnded(false);
      });
      element.addEventListener('pause', () => setPlaying(false));
      element.addEventListener('ended', () => {
        setPlaying(false);
        setEnded(true);
      });
      element.addEventListener('timeupdate', () =>
        setCurrentTime(element.currentTime),
      );
      element.addEventListener('loadedmetadata', () => {
        setDuration(Number.isFinite(element.duration) ? element.duration : 0);
        setCurrentTime(element.currentTime);
        matchTimingToMedia(element.duration);
      });
      element.addEventListener('error', () => {
        diagnostics.recordFailure(
          new Error(element.error?.message || 'The audio could not be loaded.'),
          element,
        );
      });
    },
    async load(value, lyrics, reference = null, timing = null) {
      releaseObjectUrl();
      const resolved = sourceUrl(value);
      objectUrl = resolved.disposable ? resolved.url : null;
      if (audio) {
        audio.src = resolved.url;
        audio.load();
      }
      setSource(resolved.url);
      setAnalysisBytes(resolved.bytes);
      setTitle(lyrics.title || 'Your Mehfil recording');
      setSubtitle('Fresh from MiniMax Music 3');
      setShareReference(reference);
      setLoadedTiming(normalizeLyricTiming(timing));
      setTimingMatchesMedia(false);
      setReady(true);
      setEnded(false);
      await play();
    },
    loadRoomSong(song, origin) {
      releaseObjectUrl();
      setAnalysisBytes(null);
      setLoadedTiming(null);
      setTimingMatchesMedia(false);
      const url = `${origin}/s/${song.shareId}/audio`;
      if (audio && audio.src !== url) {
        audio.src = url;
        audio.load();
      }
      setSource(url);
      setTitle(song.title || 'Mehfil recording');
      setSubtitle(song.language || 'MiniMax Music 3');
      setShareReference(null);
      setReady(true);
      setEnded(false);
    },
    syncRoomSong(song) {
      if (!audio) return;
      const playback = song.playback;
      const revision = `${song.shareId}:${playback.status}:${playback.positionMs}:${playback.changedAt}`;
      if (revision === roomRevision) return;
      roomRevision = revision;
      if (roomTimer) clearTimeout(roomTimer);
      if (roomMetadataHandler)
        audio.removeEventListener('loadedmetadata', roomMetadataHandler);
      roomMetadataHandler = null;
      const apply = () => {
        if (!audio || revision !== roomRevision) return;
        const elapsed =
          playback.status === 'playing'
            ? Math.max(0, Date.now() - playback.changedAt)
            : 0;
        const desired = (playback.positionMs + elapsed) / 1000;
        audio.currentTime = Number.isFinite(audio.duration)
          ? Math.min(desired, audio.duration)
          : desired;
        if (playback.status === 'playing') void play();
        else audio.pause();
      };
      const scheduleApply = () => {
        if (!audio || revision !== roomRevision) return;
        roomMetadataHandler = null;
        if (playback.status === 'playing' && playback.changedAt > Date.now()) {
          audio.pause();
          audio.currentTime = playback.positionMs / 1000;
          roomTimer = setTimeout(apply, playback.changedAt - Date.now());
        } else apply();
      };
      if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) scheduleApply();
      else {
        roomMetadataHandler = scheduleApply;
        audio.addEventListener('loadedmetadata', scheduleApply, { once: true });
      }
    },
    clear,
    play,
    pause() {
      audio?.pause();
    },
    async toggle() {
      if (!audio || !ready()) return;
      if (audio.paused) await play();
      else audio.pause();
    },
    seek(percent) {
      if (!audio || !Number.isFinite(audio.duration)) return;
      setEnded(false);
      audio.currentTime =
        (Math.max(0, Math.min(100, percent)) / 100) * audio.duration;
    },
    async replay() {
      if (!audio) return;
      setEnded(false);
      audio.currentTime = 0;
      await play();
    },
  };
}
