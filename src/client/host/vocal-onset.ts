import type { TimelineEntry } from '../../lyrics/lyric-sync.ts';

/** Lightweight identity/result state; never retains decoded or source audio. */
export interface VocalAnalysisResult {
  source: string;
  timeline: TimelineEntry[];
  release: number | null;
}

/**
 * Keeps a result only while it still belongs to the eligible recording input.
 * Invalid/no-byte and new-input transitions return null so stale state is
 * released immediately without making the analysis effect depend on itself.
 */
export function reconcileVocalAnalysisResult(
  result: VocalAnalysisResult | null,
  source: string,
  timeline: TimelineEntry[] | null,
  eligible: boolean,
): VocalAnalysisResult | null {
  if (!eligible || !source || !Array.isArray(timeline)) return null;
  return result?.source === source && result.timeline === timeline
    ? result
    : null;
}

/** Resolves the pending/null/value tri-state for the current analysis input. */
export function vocalAnalysisRelease(
  result: VocalAnalysisResult | null,
  source: string,
  timeline: TimelineEntry[] | null,
  eligible: boolean,
): number | null | undefined {
  if (!eligible) return null;
  return reconcileVocalAnalysisResult(result, source, timeline, true)?.release;
}

export const VOCAL_ONSET_WINDOW_MS = 20;
export const VOCAL_ONSET_BASELINE_WINDOWS = 25;
export const VOCAL_ONSET_RISE_FACTOR = 3;
export const VOCAL_ONSET_SUSTAIN_WINDOWS = 5;

export interface VocalOnsetOptions {
  baselineWindows: number;
  riseFactor: number;
  sustainWindows: number;
}

const DEFAULT_OPTIONS: VocalOnsetOptions = {
  baselineWindows: VOCAL_ONSET_BASELINE_WINDOWS,
  riseFactor: VOCAL_ONSET_RISE_FACTOR,
  sustainWindows: VOCAL_ONSET_SUSTAIN_WINDOWS,
};

function envelopeWithDeadline(
  samples: Float32Array,
  sampleRate: number,
  windowMs: number,
  deadline?: number,
): Float32Array | null {
  if (
    !(samples instanceof Float32Array) ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0
  )
    return new Float32Array();
  const windowSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const envelope = new Float32Array(Math.ceil(samples.length / windowSamples));
  for (let windowIndex = 0; windowIndex < envelope.length; windowIndex += 1) {
    if (deadline !== undefined && performance.now() > deadline) return null;
    const start = windowIndex * windowSamples;
    const end = Math.min(samples.length, start + windowSamples);
    let sumSquares = 0;
    for (let index = start; index < end; index += 1) {
      const sample = samples[index] ?? 0;
      sumSquares += sample * sample;
    }
    envelope[windowIndex] = Math.sqrt(sumSquares / Math.max(1, end - start));
  }
  return envelope;
}

/** Converts mono PCM into non-overlapping per-window RMS energy. */
export function rmsEnvelope(
  samples: Float32Array,
  sampleRate: number,
  windowMs = VOCAL_ONSET_WINDOW_MS,
): Float32Array {
  return (
    envelopeWithDeadline(samples, sampleRate, windowMs) ?? new Float32Array()
  );
}

function median(values: Float32Array, start: number, end: number): number {
  const sorted = Array.from(values.subarray(start, end)).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Finds the first energy rise sustained beyond a rolling prior-window median. */
export function firstSustainedOnset(
  envelope: Float32Array,
  windowMs: number,
  options: VocalOnsetOptions = DEFAULT_OPTIONS,
): number | null {
  const { baselineWindows, riseFactor, sustainWindows } = options;
  if (
    !(envelope instanceof Float32Array) ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0 ||
    !Number.isInteger(baselineWindows) ||
    baselineWindows < 1 ||
    !Number.isFinite(riseFactor) ||
    riseFactor <= 0 ||
    !Number.isInteger(sustainWindows) ||
    sustainWindows < 1
  )
    return null;

  for (
    let index = baselineWindows;
    index + sustainWindows <= envelope.length;
    index += 1
  ) {
    const baseline = median(envelope, index - baselineWindows, index);
    const threshold = riseFactor * baseline;
    let sustained = true;
    for (let offset = 0; offset < sustainWindows; offset += 1) {
      const value = envelope[index + offset] ?? 0;
      if (value <= 0 || value < threshold) {
        sustained = false;
        break;
      }
    }
    if (sustained) return (index * windowMs) / 1000;
  }
  return null;
}

function bandLimitMidChannel(
  buffer: AudioBuffer,
  startSample: number,
  endSample: number,
  deadline: number,
): Float32Array | null {
  const length = endSample - startSample;
  const mono = new Float32Array(length);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const sampleRate = buffer.sampleRate;
  const timeStep = 1 / sampleRate;
  const highPassAlpha =
    1 / (2 * Math.PI * 200) / (1 / (2 * Math.PI * 200) + timeStep);
  const lowPassAlpha = timeStep / (1 / (2 * Math.PI * 4000) + timeStep);
  let previousInput = 0;
  let highPassed = 0;
  let lowPassed = 0;

  for (let offset = 0; offset < length; offset += 1) {
    if (offset % 8192 === 0 && performance.now() > deadline) return null;
    const index = startSample + offset;
    const input = ((left[index] ?? 0) + (right[index] ?? 0)) / 2;
    highPassed = highPassAlpha * (highPassed + input - previousInput);
    previousInput = input;
    lowPassed += lowPassAlpha * (highPassed - lowPassed);
    mono[offset] = lowPassed;
  }
  return mono;
}

/**
 * Decodes same-origin audio bytes and returns an approximate absolute vocal
 * entry inside the requested search window. Any browser or decode failure is
 * an ordinary null result so playback is never blocked.
 */
export async function detectVocalEntry(
  arrayBuffer: ArrayBuffer,
  searchStart: number,
  searchEnd: number,
): Promise<number | null> {
  try {
    if (
      !(arrayBuffer instanceof ArrayBuffer) ||
      !Number.isFinite(searchStart) ||
      !Number.isFinite(searchEnd) ||
      searchEnd <= searchStart
    )
      return null;
    const deadline = performance.now() + 5000;
    const context = new OfflineAudioContext(1, 1, 44_100);
    const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
    if (performance.now() > deadline) return null;
    const start = Math.max(0, Math.min(searchStart, decoded.duration));
    const end = Math.max(start, Math.min(searchEnd, decoded.duration));
    if (end <= start) return null;
    const startSample = Math.floor(start * decoded.sampleRate);
    const endSample = Math.min(
      decoded.length,
      Math.ceil(end * decoded.sampleRate),
    );
    const filtered = bandLimitMidChannel(
      decoded,
      startSample,
      endSample,
      deadline,
    );
    if (!filtered) return null;
    const envelope = envelopeWithDeadline(
      filtered,
      decoded.sampleRate,
      VOCAL_ONSET_WINDOW_MS,
      deadline,
    );
    if (!envelope) return null;
    const onset = firstSustainedOnset(envelope, VOCAL_ONSET_WINDOW_MS);
    return onset === null ? null : start + onset;
  } catch {
    return null;
  }
}

/** Clamps a detected onset into the first mapped vocal section's safe gate. */
export function vocalGateSeconds(
  timeline: TimelineEntry[] | null,
  onsetSeconds: number | null,
): number | null {
  if (!Array.isArray(timeline) || !Number.isFinite(onsetSeconds)) return null;
  const entry = timeline.find(
    (candidate) =>
      candidate.sectionIndex !== null &&
      candidate.label !== 'inst' &&
      candidate.label !== 'silence',
  );
  if (!entry) return null;
  const latest = entry.start + Math.min(8, (entry.end - entry.start) / 2);
  // SAFETY: the guard above returned on null and every non-finite value, so
  // onsetSeconds is a finite number here; Number.isFinite does not narrow its
  // parameter type, which is why the assertion is required.
  return Math.max(entry.start, Math.min(onsetSeconds as number, latest));
}
