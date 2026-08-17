import { createSignal } from 'solid-js';

import {
  clearPendingGeneration,
  createJobId,
  savePendingGeneration,
  type HostLyrics,
} from './generation-recovery.ts';
import type { PlayerController } from './player-controller.ts';

export interface GenerationController {
  status: () => string;
  generating: () => boolean;
  lyrics: () => HostLyrics | null;
  generate(input: {
    token: string;
    idea: string;
    vibe: string;
    language: string;
  }): Promise<void>;
}

export type GenerationFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLyrics(value: unknown): HostLyrics | null {
  if (!isRecord(value)) return null;
  const required = [
    'title',
    'language',
    'nativeScriptName',
    'lyricsNative',
    'lyricsRoman',
    'prompt',
  ] as const;
  if (required.some((key) => typeof value[key] !== 'string')) return null;
  return {
    title: String(value.title),
    language: String(value.language),
    languageCode:
      typeof value.languageCode === 'string' ? value.languageCode : '',
    nativeScriptName: String(value.nativeScriptName),
    isLatinScript: value.isLatinScript === true,
    lyricsNative: String(value.lyricsNative),
    lyricsRoman: String(value.lyricsRoman),
    prompt: String(value.prompt),
  };
}

function sourceFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const data = isRecord(value.data) ? value.data : {};
  return typeof data.audio === 'string' ? data.audio : null;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createGenerationController({
  player,
  fetcher = (input, init) => fetch(input, init),
  storage = sessionStorage,
  onSongReady = () => undefined,
}: {
  player: PlayerController;
  fetcher?: GenerationFetch;
  storage?: Storage;
  onSongReady?: (jobId: string, lyrics: HostLyrics) => void;
}): GenerationController {
  const [status, setStatus] = createSignal('Ready when you are.');
  const [generating, setGenerating] = createSignal(false);
  const [lyrics, setLyrics] = createSignal<HostLyrics | null>(null);
  let run = 0;

  const waitForCompletion = async (jobId: string): Promise<unknown> => {
    for (const delay of [0, 2_000, 3_000, 5_000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const response = await fetcher(
        `/api/generation-status?id=${encodeURIComponent(jobId)}`,
      );
      const value = await json(response);
      if (!response.ok)
        throw new Error('Recording recovery is temporarily unavailable.');
      if (isRecord(value) && value.status === 'complete') return value;
      if (isRecord(value) && value.status === 'failed')
        throw new Error('Generation failed.');
    }
    throw new Error('The recording is still being made. Check again shortly.');
  };

  return {
    status,
    generating,
    lyrics,
    async generate(input) {
      if (generating()) return;
      const thisRun = ++run;
      setGenerating(true);
      setStatus('Writing your song…');
      try {
        const lyricResponse = await fetcher('/api/write-lyrics', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        const sheet = parseLyrics(await json(lyricResponse));
        if (!lyricResponse.ok || !sheet)
          throw new Error('Could not write lyrics.');
        if (thisRun !== run) return;
        setLyrics(sheet);
        const jobId = createJobId();
        savePendingGeneration(storage, jobId, sheet);
        setStatus('The band is recording…');
        const generationResponse = await fetcher('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: input.token,
            lyrics: sheet.lyricsNative || sheet.lyricsRoman,
            prompt: sheet.prompt,
            jobId,
          }),
        });
        let result = await json(generationResponse);
        if (generationResponse.status === 202)
          result = await waitForCompletion(jobId);
        const source = sourceFrom(result);
        if (!generationResponse.ok && generationResponse.status !== 202)
          throw new Error('Generation failed.');
        if (!source) throw new Error('The finished recording is unavailable.');
        clearPendingGeneration(storage);
        await player.load(source, sheet);
        onSongReady(jobId, sheet);
        setStatus('Your recording is ready.');
      } catch (error) {
        setStatus(
          error instanceof Error ? error.message : 'Generation failed.',
        );
      } finally {
        if (thisRun === run) setGenerating(false);
      }
    },
  };
}
