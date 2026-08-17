import { createSignal, getOwner, onCleanup } from 'solid-js';

import { normalizeLyricTiming } from '../../lyrics/lyric-sync.ts';
import {
  TIMING_FAILURE_REASONS,
  type TimingAnalysisOutcome,
  type TimingFailureReason,
} from '../../timing/timing-analysis.ts';

export const TIMING_ANALYSIS_DEADLINE_MS = 180_000;
export const TIMING_ANALYSIS_MAX_ATTEMPTS = 2;

export type TimingState =
  | { status: 'idle' }
  | { status: 'pending'; attempt: number }
  | {
      status: 'ready';
      timing: NonNullable<ReturnType<typeof normalizeLyricTiming>>;
    }
  | { status: 'unavailable'; reason: TimingFailureReason };

export type SettledTimingState = Extract<
  TimingState,
  { status: 'ready' | 'unavailable' }
>;

export interface TimingAnalysisRequest {
  source: string;
  token: string;
  signal: AbortSignal;
}

export interface TimingAnalysisPort {
  analyze(input: TimingAnalysisRequest): Promise<TimingAnalysisOutcome>;
}

export interface TimingAnalysisController {
  state(): TimingState;
  analyze(input: { source: string; token: string }): Promise<void>;
  settled(): Promise<SettledTimingState>;
  cancel(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFailureReason(value: unknown): value is TimingFailureReason {
  return (
    typeof value === 'string' &&
    (TIMING_FAILURE_REASONS as readonly string[]).includes(value)
  );
}

function mayRetry(
  outcome: Extract<TimingAnalysisOutcome, { status: 'unavailable' }>,
) {
  return (
    outcome.retryable &&
    (outcome.reason === 'timeout' ||
      outcome.reason === 'network' ||
      outcome.reason === 'provider-busy' ||
      outcome.reason === 'provider-http')
  );
}

function parseOutcome(value: unknown): TimingAnalysisOutcome | null {
  if (!isRecord(value)) return null;
  if (value.status === 'ready') {
    const timing = normalizeLyricTiming(value.timing);
    return timing ? { status: 'ready', timing } : null;
  }
  if (
    value.status === 'unavailable' &&
    isFailureReason(value.reason) &&
    typeof value.retryable === 'boolean'
  ) {
    return {
      status: 'unavailable',
      reason: value.reason,
      retryable: value.retryable,
    };
  }
  return null;
}

function httpFailure(status: number): TimingAnalysisOutcome {
  if (status === 401 || status === 403) {
    return {
      status: 'unavailable',
      reason: 'authentication',
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      status: 'unavailable',
      reason: 'provider-busy',
      retryable: true,
    };
  }
  return {
    status: 'unavailable',
    reason:
      status === 408 || status >= 500 ? 'provider-http' : 'malformed-response',
    retryable: status === 408 || status >= 500,
  };
}

export function createHttpTimingAnalysisPort(
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = (
    input,
    init,
  ) => fetch(input, init),
): TimingAnalysisPort {
  return {
    async analyze(input) {
      const response = await fetcher('/api/analyze-timing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: input.source,
          token: input.token,
        }),
        signal: input.signal,
      });
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return httpFailure(response.status);
      }
      return parseOutcome(value) ?? httpFailure(response.status);
    },
  };
}

export function createTimingAnalysisController({
  port = createHttpTimingAnalysisPort(),
  deadlineMs = TIMING_ANALYSIS_DEADLINE_MS,
  maxAttempts = TIMING_ANALYSIS_MAX_ATTEMPTS,
}: {
  port?: TimingAnalysisPort;
  deadlineMs?: number;
  maxAttempts?: number;
} = {}): TimingAnalysisController {
  const [state, setState] = createSignal<TimingState>({ status: 'idle' });
  let revision = 0;
  let activeAbort: AbortController | null = null;
  let settlement: Promise<SettledTimingState> = new Promise(() => undefined);
  let settle: ((value: SettledTimingState) => void) | null = null;

  const resetSettlement = () => {
    settlement = new Promise<SettledTimingState>((resolve) => {
      settle = resolve;
    });
  };
  const finish = (value: SettledTimingState) => {
    setState(value);
    settle?.(value);
    settle = null;
  };
  const cancelPending = () => {
    revision += 1;
    activeAbort?.abort();
    activeAbort = null;
    if (state().status === 'pending') {
      finish({ status: 'unavailable', reason: 'cancelled' });
    }
  };

  if (getOwner()) onCleanup(cancelPending);

  return {
    state,
    async analyze(input) {
      cancelPending();
      const run = ++revision;
      resetSettlement();

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (run !== revision) return;
        setState({ status: 'pending', attempt });
        const controller = new AbortController();
        activeAbort = controller;
        let deadlineReached = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
          const timeoutError = new Error('Timing analysis deadline reached.');
          timeoutError.name = 'TimeoutError';
          timeout = setTimeout(() => {
            deadlineReached = true;
            controller.abort();
            reject(timeoutError);
          }, deadlineMs);
        });
        let outcome: TimingAnalysisOutcome;
        try {
          outcome = await Promise.race([
            port.analyze({
              source: input.source,
              token: input.token,
              signal: controller.signal,
            }),
            deadline,
          ]);
        } catch {
          outcome = {
            status: 'unavailable',
            reason: deadlineReached ? 'timeout' : 'network',
            retryable: true,
          };
        } finally {
          if (timeout) clearTimeout(timeout);
          if (activeAbort === controller) activeAbort = null;
        }
        if (run !== revision) return;

        const normalized = parseOutcome(outcome) ?? {
          status: 'unavailable' as const,
          reason: 'invalid-timing' as const,
          retryable: false,
        };
        if (normalized.status === 'ready') {
          finish(normalized);
          return;
        }
        if (mayRetry(normalized) && attempt < maxAttempts) continue;
        finish({ status: 'unavailable', reason: normalized.reason });
        return;
      }
    },
    settled: () => {
      const current = state();
      return current.status === 'ready' || current.status === 'unavailable'
        ? Promise.resolve(current)
        : settlement;
    },
    cancel: cancelPending,
  };
}
