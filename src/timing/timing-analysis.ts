import type { LyricTiming } from '../lyrics/lyric-sync.ts';

export const TIMING_FAILURE_REASONS = [
  'unsupported-source',
  'timeout',
  'network',
  'authentication',
  'provider-busy',
  'provider-http',
  'malformed-response',
  'invalid-timing',
  'cancelled',
] as const;

export type TimingFailureReason = (typeof TIMING_FAILURE_REASONS)[number];

export type TimingAnalysisOutcome =
  | { status: 'ready'; timing: LyricTiming }
  | {
      status: 'unavailable';
      reason: TimingFailureReason;
      retryable: boolean;
    };

export const TIMING_DIAGNOSTIC_EVENTS = [
  'provider-start',
  'provider-response',
  'provider-timeout',
  'provider-retry',
  'provider-terminal',
  'host-artifact-receipt',
  'host-source-validation',
  'host-media-validation',
  'host-map',
  'share-waiting',
  'share-ready',
  'share-terminal-untimed',
  'room-waiting',
  'room-ready',
  'room-terminal-untimed',
  'listener-artifact-receipt',
  'listener-media-validation',
  'listener-map',
  'shared-page-validation',
] as const;

export type TimingDiagnosticEvent = (typeof TIMING_DIAGNOSTIC_EVENTS)[number];

export type TimingDiagnosticSurface =
  'provider' | 'host' | 'share' | 'room' | 'listener' | 'shared-page';

export type TimingDiagnosticReason =
  | TimingFailureReason
  | 'ready'
  | 'pending'
  | 'stale'
  | 'source-match'
  | 'source-mismatch'
  | 'duration-match'
  | 'duration-mismatch'
  | 'mapped'
  | 'weak-map'
  | 'untimed';

export interface TimingDiagnostic {
  event: TimingDiagnosticEvent;
  surface: TimingDiagnosticSurface;
  reason?: TimingDiagnosticReason;
  attempt?: number;
  elapsedMs?: number;
  deadlineMs?: number;
  httpStatus?: number;
  providerStatus?: number;
  segmentCount?: number;
  sectionCount?: number;
  analyzedDurationSeconds?: number;
  mediaDurationSeconds?: number;
}

export type TimingDiagnosticSink = (diagnostic: TimingDiagnostic) => void;

const numericFields = [
  'attempt',
  'elapsedMs',
  'deadlineMs',
  'httpStatus',
  'providerStatus',
  'segmentCount',
  'sectionCount',
  'analyzedDurationSeconds',
  'mediaDurationSeconds',
] as const;

/**
 * Emits only the fixed privacy-safe timing vocabulary. The explicit copy is a
 * runtime guard as well as a TypeScript boundary: accidental URLs, tokens, raw
 * payloads, lyrics, transcripts and provider identifiers are dropped.
 */
export const emitTimingDiagnostic: TimingDiagnosticSink = (diagnostic) => {
  const safe: Record<string, string | number> = {
    event: diagnostic.event,
    surface: diagnostic.surface,
  };
  if (diagnostic.reason) safe.reason = diagnostic.reason;
  for (const field of numericFields) {
    const value = diagnostic[field];
    if (typeof value === 'number' && Number.isFinite(value))
      safe[field] = value;
  }
  console.info('[TIMING-DIAGNOSTIC]', safe);
};
