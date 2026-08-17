import { createSignal, getOwner, onCleanup } from 'solid-js';

import { normalizeLyricTiming } from '../../lyrics/lyric-sync.ts';
import { isRecord, parseLyricsSheet } from '../../room/protocol.ts';
import {
  emitTimingDiagnostic,
  type TimingDiagnosticSink,
} from '../../timing/timing-analysis.ts';
import {
  createRecoveryCoordinator,
  type GenerationContext,
  type HostLyrics,
  type PendingGeneration,
  type StatusResponse,
} from './generation-recovery.ts';
import type { PlayerController } from './player-controller.ts';
import {
  createHttpTimingAnalysisPort,
  createTimingAnalysisController,
  type SettledTimingState,
  type TimingAnalysisController,
} from './timing-analysis-controller.ts';
import { trustedRemoteAudioSource } from './replay-source.ts';

const WRITING_LINES = [
  'Listening to your idea…',
  'Finding the language…',
  'Looking for a rhyme…',
  'Shaping the chorus…',
];
const RECORDING_LINES = [
  'The harmonium warms up…',
  'Tabla finds the taal…',
  'The singer clears their throat…',
  'First take, everyone quiet…',
  'Almost there. Good songs take a moment…',
];

export interface GenerateInput {
  token: string;
  idea: string;
  vibe: string;
  language: string;
}
export interface GeneratedSong {
  lyricSheet: HostLyrics;
  shareReference: string | null;
  requestRun: number;
  context: GenerationContext;
  source: string;
  timingSettled: Promise<SettledTimingState>;
}
export interface ShareResult {
  url: string;
  copied: boolean;
}
export interface GenerationHooks {
  context?: GenerationContext;
  onLyrics?: (sheet: HostLyrics, run: number) => void;
  onReady?: (song: GeneratedSong) => void | Promise<void>;
  onFailed?: (error: Error, run: number) => void;
}
export interface GenerationController {
  status: () => string;
  statusWorking: () => boolean;
  generating: () => boolean;
  lyrics: () => HostLyrics | null;
  shareReference: () => string | null;
  checkGenerationVisible: () => boolean;
  performanceAvailable: () => boolean;
  pendingContext: () => GenerationContext;
  acknowledgeRoomOutcome(roomId: string, requestId: string): boolean;
  generate(
    input: GenerateInput,
    hooks?: GenerationHooks,
  ): Promise<GeneratedSong | undefined>;
  share(copy?: boolean, song?: GeneratedSong): Promise<ShareResult | undefined>;
  resumePending(
    reason?:
      | 'page-load'
      | 'pageshow'
      | 'visibilitychange'
      | 'pending-response'
      | 'generate-request-rejected',
    hooks?: GenerationHooks,
  ): boolean;
  checkGeneration(): void;
  lifecycleBackgrounded(): void;
  lifecycleForegrounded(): void;
}

export type GenerationFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
interface HttpError extends Error {
  httpStatus?: number;
}

function parseLyrics(value: unknown): HostLyrics | null {
  const sheet = parseLyricsSheet(value);
  if (!sheet || !isRecord(value) || typeof value.prompt !== 'string')
    return null;
  return {
    ...sheet,
    languageCode:
      typeof value.languageCode === 'string' ? value.languageCode : '',
    prompt: value.prompt,
  };
}
function audioSource(value: Record<string, unknown>): string | null {
  if (typeof value.audio === 'string') return value.audio;
  if (isRecord(value.audio) && typeof value.audio.url === 'string')
    return value.audio.url;
  return isRecord(value.data) && typeof value.data.audio === 'string'
    ? value.data.audio
    : null;
}
async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return { error: 'The server returned an unreadable response.' };
  }
}

export function createGenerationController({
  player,
  fetcher = (input, init) => fetch(input, init),
  storage = sessionStorage,
  now = Date.now,
  visible = () =>
    typeof document === 'undefined' || document.visibilityState === 'visible',
  timingAnalysis,
  timingDiagnostic = emitTimingDiagnostic,
}: {
  player: PlayerController;
  fetcher?: GenerationFetch;
  storage?: Storage;
  now?: () => number;
  visible?: () => boolean;
  timingAnalysis?: TimingAnalysisController;
  timingDiagnostic?: TimingDiagnosticSink;
}): GenerationController {
  const analysis =
    timingAnalysis ??
    createTimingAnalysisController({
      port: createHttpTimingAnalysisPort(fetcher),
      diagnostic: timingDiagnostic,
    });
  const [status, setStatus] = createSignal('');
  const [statusWorking, setStatusWorking] = createSignal(false);
  const [generating, setGenerating] = createSignal(false);
  const [lyrics, setLyrics] = createSignal<HostLyrics | null>(null);
  const [shareReference, setShareReference] = createSignal<string | null>(null);
  const [shareUrl, setShareUrl] = createSignal<string | null>(null);
  const [checkGenerationVisible, setCheckGenerationVisible] =
    createSignal(false);
  const [performanceAvailable, setPerformanceAvailable] = createSignal(false);
  let run = 0;
  let generationRequestInFlight = false;
  let lifecycleBackgroundVersion = 0;
  let activeHooks: GenerationHooks = {};
  let latestSong: GeneratedSong | null = null;
  let waitingTimer: ReturnType<typeof setInterval> | null = null;
  const foregroundWaiters: Array<() => void> = [];

  const setBusy = (lines: readonly string[]) => {
    if (waitingTimer) clearInterval(waitingTimer);
    waitingTimer = null;
    if (!lines.length) return;
    let index = 0;
    setStatus(lines[index] ?? 'Working…');
    waitingTimer = setInterval(() => {
      index = (index + 1) % lines.length;
      setStatus(lines[index] ?? 'Working…');
    }, 6_000);
  };
  if (getOwner())
    onCleanup(() => {
      if (waitingTimer) clearInterval(waitingTimer);
      recovery.cancel();
      analysis.cancel();
    });

  const requestJson = async (
    url: string,
    payload: unknown,
  ): Promise<Record<string, unknown>> => {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const value = await responseJson(response);
    if (!response.ok) {
      const error = new Error(
        typeof value.error === 'string' ? value.error : 'Something went wrong.',
      ) as HttpError;
      error.httpStatus = response.status;
      throw error;
    }
    return value;
  };

  const fail = (message: string, clear = true, background = false) => {
    setCheckGenerationVisible(false);
    if (clear) recovery.clear();
    setGenerating(false);
    setBusy([]);
    setStatusWorking(false);
    setStatus(message);
    if (!background) setPerformanceAvailable(false);
  };
  const finalize = async (
    result: Record<string, unknown>,
    pending: PendingGeneration & { run: number },
    analysisToken?: string,
  ): Promise<GeneratedSong | null> => {
    if (
      pending.run !== run ||
      (result.jobId !== undefined && result.jobId !== pending.jobId)
    )
      return null;
    const background = pending.context?.kind === 'room-recording';
    const source = audioSource(result);
    if (!source) {
      const error = new Error(
        'MiniMax succeeded but did not return an audio file.',
      );
      fail(error.message, !background, background);
      activeHooks.onFailed?.(error, pending.run);
      return null;
    }
    if (!background) setLyrics(pending.lyricSheet);
    const reference =
      typeof result.share_ref === 'string' ? result.share_ref : null;
    if (!background) {
      setShareReference(reference);
      setShareUrl(null);
    }
    setCheckGenerationVisible(false);
    if (!background) {
      await player.load(
        source,
        pending.lyricSheet,
        reference,
        result.lyric_timing,
      );
      recovery.clear();
    }
    let timingSettled: Promise<SettledTimingState>;
    if (analysisToken && trustedRemoteAudioSource(source)) {
      void analysis.analyze({ source, token: analysisToken });
      timingSettled = analysis.settled();
      if (!background) {
        void timingSettled.then((settled) => {
          if (settled.status === 'ready')
            player.applyTiming(source, settled.timing);
        });
      }
    } else {
      const legacyTiming = normalizeLyricTiming(result.lyric_timing);
      timingSettled = Promise.resolve(
        legacyTiming
          ? { status: 'ready', timing: legacyTiming }
          : { status: 'unavailable', reason: 'unsupported-source' },
      );
    }
    setGenerating(false);
    setBusy([]);
    setStatusWorking(true);
    setStatus('Your recording is ready.');
    if (!background) setPerformanceAvailable(true);
    const song: GeneratedSong = {
      lyricSheet: pending.lyricSheet,
      shareReference: reference,
      requestRun: run,
      context: pending.context ?? null,
      source,
      timingSettled,
    };
    if (!background) latestSong = song;
    await activeHooks.onReady?.(song);
    return song;
  };

  const recovery = createRecoveryCoordinator({
    storage,
    now,
    visibility: visible,
    fetchStatus: async (jobId): Promise<StatusResponse> => {
      const response = await fetcher(
        `/api/generation-status?id=${encodeURIComponent(jobId)}`,
      );
      return {
        ok: response.ok,
        status: response.status,
        value: await responseJson(response),
      };
    },
    onRequest: () => setCheckGenerationVisible(false),
    onPending: () => {
      setBusy([]);
      setGenerating(true);
    },
    onComplete: (value, pending) => {
      void finalize(value, pending).catch((value: unknown) => {
        const error =
          value instanceof Error ? value : new Error('Generation failed.');
        const background = pending.context?.kind === 'room-recording';
        fail(error.message, !background, background);
        activeHooks.onFailed?.(error, pending.run);
      });
    },
    onFailed: (value, pending) => {
      if (pending.run !== run) return;
      const error = new Error(
        typeof value.error === 'string' ? value.error : 'Generation failed.',
      );
      const background = pending.context?.kind === 'room-recording';
      fail(error.message, !background, background);
      activeHooks.onFailed?.(error, pending.run);
    },
    onExpired: (value, pending) => {
      if (pending.run !== run) return;
      const error = new Error(
        typeof value.error === 'string'
          ? value.error
          : 'That recording can no longer be recovered.',
      );
      const background = pending.context?.kind === 'room-recording';
      fail(error.message, !background, background);
      activeHooks.onFailed?.(error, pending.run);
    },
    onRetryable: (error, pending) => {
      if (pending.run !== run) return;
      if (error.status === 503 && /cannot recover/i.test(error.message)) {
        recovery.cancel();
        fail(error.message);
        return;
      }
      setStatusWorking(false);
      setStatus(
        'We’re having trouble checking your recording. It may still be finishing.',
      );
      setBusy([]);
      setGenerating(true);
      setCheckGenerationVisible(true);
    },
  });

  const waitForForeground = () =>
    visible()
      ? Promise.resolve()
      : new Promise<void>((resolve) => foregroundWaiters.push(resolve));
  const writeLyricsAcrossLifecycle = async (
    payload: GenerateInput,
  ): Promise<HostLyrics> => {
    let background = lifecycleBackgroundVersion;
    while (true) {
      try {
        const sheet = parseLyrics(
          await requestJson('/api/write-lyrics', payload),
        );
        if (!sheet) throw new Error('Could not write lyrics.');
        return sheet;
      } catch (error) {
        const http = (error as HttpError).httpStatus;
        const interrupted =
          !Number.isInteger(http) && lifecycleBackgroundVersion !== background;
        if (!interrupted) throw error;
        background = lifecycleBackgroundVersion;
        await waitForForeground();
      }
    }
  };

  const resumePending = (
    _reason?: Parameters<GenerationController['resumePending']>[0],
    hooks?: GenerationHooks,
    pending = recovery.read(),
  ): boolean => {
    if (generationRequestInFlight || !pending) return false;
    if (
      pending.context?.kind === 'room-recording' &&
      (hooks?.context?.kind !== 'room-recording' ||
        hooks.context.roomId !== pending.context.roomId ||
        hooks.context.requestId !== pending.context.requestId)
    ) {
      return false;
    }
    if (hooks) activeHooks = hooks;
    const current = recovery.current();
    if (current?.jobId === pending.jobId) {
      recovery.resume();
      return true;
    }
    run += 1;
    if (pending.context?.kind !== 'room-recording') {
      setLyrics(pending.lyricSheet);
      setPerformanceAvailable(true);
    }
    setGenerating(true);
    setBusy(RECORDING_LINES);
    setStatusWorking(true);
    setStatus(RECORDING_LINES[0] ?? 'The band is recording…');
    setCheckGenerationVisible(false);
    recovery.start(pending, run);
    return true;
  };

  return {
    status,
    statusWorking,
    generating,
    lyrics,
    shareReference,
    checkGenerationVisible,
    performanceAvailable,
    pendingContext: () => recovery.read()?.context ?? null,
    acknowledgeRoomOutcome(roomId, requestId) {
      const context = recovery.read()?.context;
      if (
        context?.kind !== 'room-recording' ||
        context.roomId !== roomId ||
        context.requestId !== requestId
      ) {
        return false;
      }
      recovery.cancel();
      recovery.clear();
      return true;
    },
    async generate(input, hooks = {}) {
      if (generating()) return undefined;
      const context = hooks.context ?? null;
      const background = context?.kind === 'room-recording';
      const previous = recovery.read();
      if (
        previous &&
        typeof confirm === 'function' &&
        !confirm(
          'A recording is still being followed in this tab. Start a new song and stop checking it?',
        )
      )
        return undefined;
      recovery.cancel();
      recovery.clear();
      analysis.cancel();
      if (!background) player.clear();
      run += 1;
      const requestRun = run;
      activeHooks = hooks;
      if (!background) {
        setLyrics(null);
        setShareReference(null);
        setShareUrl(null);
        latestSong = null;
        setPerformanceAvailable(true);
      }
      setGenerating(true);
      setBusy(WRITING_LINES);
      setStatusWorking(true);
      setStatus(WRITING_LINES[0] ?? 'Writing your song…');
      let pending: (PendingGeneration & { run: number }) | null = null;
      let stage: 'write-lyrics' | 'generate-music' | 'load-song' =
        'write-lyrics';
      try {
        const sheet = await writeLyricsAcrossLifecycle(input);
        if (requestRun !== run)
          throw new Error('This recording was replaced by a newer request.');
        if (!background) setLyrics(sheet);
        hooks.onLyrics?.(sheet, requestRun);
        setBusy(RECORDING_LINES);
        setStatus(RECORDING_LINES[0] ?? 'The band is recording…');
        stage = 'generate-music';
        const jobId = recovery.createJobId();
        pending = {
          ...recovery.save({ jobId, lyricSheet: sheet, context }),
          run: requestRun,
        };
        generationRequestInFlight = true;
        let result: Record<string, unknown>;
        try {
          result = await requestJson('/api/generate', {
            jobId,
            token: input.token,
            prompt: sheet.prompt || input.vibe,
            lyrics: sheet.lyricsNative || sheet.lyricsRoman,
          });
        } finally {
          generationRequestInFlight = false;
        }
        if (result.status === 'pending') {
          resumePending('pending-response', hooks, pending);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          return undefined;
        }
        stage = 'load-song';
        return (
          (await finalize(
            {
              ...result,
              jobId: typeof result.jobId === 'string' ? result.jobId : jobId,
            },
            pending,
            input.token,
          )) ?? undefined
        );
      } catch (value) {
        const error =
          value instanceof Error ? value : new Error('Generation failed.');
        if (
          stage === 'generate-music' &&
          pending &&
          !Number.isInteger((error as HttpError).httpStatus)
        ) {
          resumePending('generate-request-rejected', hooks, pending);
          return undefined;
        }
        if (pending && !background) recovery.clear();
        setStatusWorking(false);
        setStatus(error.message);
        if (!background) setPerformanceAvailable(false);
        hooks.onFailed?.(error, requestRun);
        throw error;
      } finally {
        if (!recovery.current()) {
          setGenerating(false);
          setBusy([]);
        }
      }
    },
    async share(copy = true, song) {
      const selectedSong = song ?? latestSong;
      const reference = selectedSong?.shareReference ?? shareReference();
      const sheet = selectedSong?.lyricSheet ?? lyrics();
      const requestRun = selectedSong?.requestRun ?? run;
      if (!reference || !sheet) return undefined;
      const pendingTiming = selectedSong?.timingSettled;
      let lyricTiming = null;
      if (pendingTiming) {
        const current = analysis.state();
        if (current.status === 'pending')
          timingDiagnostic({
            event: 'share-waiting',
            surface: 'share',
            reason: 'pending',
            attempt: current.attempt,
          });
        const settled = await pendingTiming;
        if (requestRun !== run) return undefined;
        if (settled.status === 'ready') {
          lyricTiming = settled.timing;
          timingDiagnostic({
            event: 'share-ready',
            surface: 'share',
            reason: 'ready',
            segmentCount: settled.timing.segments.length,
            analyzedDurationSeconds: settled.timing.durationSeconds,
          });
        } else {
          timingDiagnostic({
            event: 'share-terminal-untimed',
            surface: 'share',
            reason: settled.reason,
          });
        }
      }
      let url = song ? null : shareUrl();
      if (!url) {
        const result = await requestJson('/api/share', {
          shareRef: reference,
          title: sheet.title,
          language: sheet.language,
          nativeScriptName: sheet.nativeScriptName,
          isLatinScript: sheet.isLatinScript,
          lyricsNative: sheet.lyricsNative,
          lyricsRoman: sheet.lyricsRoman,
          lyricTiming,
        });
        if (requestRun !== run || (!song && reference !== shareReference()))
          return undefined;
        if (typeof result.url !== 'string')
          throw new Error('The share service returned an invalid link.');
        url = result.url;
        if (!song) setShareUrl(url);
      }
      if (copy) {
        try {
          await navigator.clipboard.writeText(url);
          setStatus('Share link copied. The mehfil can travel now.');
          return { url, copied: true };
        } catch {
          setStatus(`Share link: ${url}`);
        }
      }
      return { url, copied: false };
    },
    resumePending,
    checkGeneration() {
      setCheckGenerationVisible(false);
      setStatusWorking(true);
      setStatus('Checking whether your recording finished…');
      recovery.resume();
    },
    lifecycleBackgrounded() {
      lifecycleBackgroundVersion += 1;
    },
    lifecycleForegrounded() {
      foregroundWaiters.splice(0).forEach((resolve) => resolve());
    },
  };
}
