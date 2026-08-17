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
