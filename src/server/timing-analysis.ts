import { normalizeLyricTiming } from '../lyrics/lyric-sync.ts';
import {
  emitTimingDiagnostic,
  type TimingAnalysisOutcome,
  type TimingDiagnosticSink,
  type TimingFailureReason,
} from '../timing/timing-analysis.ts';

export interface TimingAnalysisFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface AnalyzeMiniMaxTimingInput {
  source: string;
  token: string;
  attempt?: number;
}

export interface AnalyzeMiniMaxTimingOptions {
  apiBase: string;
  fetchImpl: TimingAnalysisFetch;
  timeoutMs: number;
  diagnostic?: TimingDiagnosticSink;
  now?: () => number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(
  reason: TimingFailureReason,
  retryable: boolean,
): TimingAnalysisOutcome {
  return { status: 'unavailable', reason, retryable };
}

function safeHttpsSource(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      value.length <= 32 * 1024
    );
  } catch {
    return false;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function providerFailure(
  status: number,
  message: unknown,
): { reason: TimingFailureReason; retryable: boolean } {
  const text = typeof message === 'string' ? message : '';
  if (
    status === 401 ||
    status === 403 ||
    /auth|token|unauthori|forbidden/i.test(text)
  ) {
    return { reason: 'authentication', retryable: false };
  }
  if (status === 429 || /busy|capacity|overload|try again/i.test(text)) {
    return { reason: 'provider-busy', retryable: true };
  }
  return {
    reason: 'provider-http',
    retryable: status === 408 || status >= 500,
  };
}

export async function analyzeMiniMaxTiming(
  input: AnalyzeMiniMaxTimingInput,
  options: AnalyzeMiniMaxTimingOptions,
): Promise<TimingAnalysisOutcome> {
  const diagnostic = options.diagnostic ?? emitTimingDiagnostic;
  const attempt =
    Number.isSafeInteger(input.attempt) && Number(input.attempt) > 0
      ? Number(input.attempt)
      : 1;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const elapsedMs = () => Math.max(0, Math.round(now() - startedAt));
  const terminal = (
    outcome: TimingAnalysisOutcome,
    details: { httpStatus?: number; providerStatus?: number } = {},
  ) => {
    diagnostic({
      event: 'provider-terminal',
      surface: 'provider',
      attempt,
      elapsedMs: elapsedMs(),
      deadlineMs: options.timeoutMs,
      reason: outcome.status === 'ready' ? 'ready' : outcome.reason,
      ...(details.httpStatus === undefined
        ? {}
        : { httpStatus: details.httpStatus }),
      ...(details.providerStatus === undefined
        ? {}
        : { providerStatus: details.providerStatus }),
      ...(outcome.status === 'ready'
        ? {
            segmentCount: outcome.timing.segments.length,
            analyzedDurationSeconds: outcome.timing.durationSeconds,
          }
        : {}),
    });
    return outcome;
  };

  if (!safeHttpsSource(input.source)) {
    return terminal(unavailable('unsupported-source', false));
  }

  diagnostic({
    event: 'provider-start',
    surface: 'provider',
    attempt,
    deadlineMs: options.timeoutMs,
  });

  let response: Response;
  try {
    response = await options.fetchImpl(
      `${options.apiBase}/v1/music_cover_preprocess`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'music-cover',
          audio_url: input.source,
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
  } catch (error) {
    const timedOut =
      errorName(error) === 'AbortError' || errorName(error) === 'TimeoutError';
    const outcome = unavailable(timedOut ? 'timeout' : 'network', true);
    if (timedOut) {
      diagnostic({
        event: 'provider-timeout',
        surface: 'provider',
        attempt,
        elapsedMs: elapsedMs(),
        deadlineMs: options.timeoutMs,
        reason: 'timeout',
      });
    }
    return terminal(outcome);
  }

  let value: unknown;
  try {
    value = JSON.parse(await response.text()) as unknown;
  } catch {
    diagnostic({
      event: 'provider-response',
      surface: 'provider',
      attempt,
      elapsedMs: elapsedMs(),
      deadlineMs: options.timeoutMs,
      httpStatus: response.status,
    });
    if (!response.ok) {
      const failure = providerFailure(response.status, '');
      return terminal(unavailable(failure.reason, failure.retryable), {
        httpStatus: response.status,
      });
    }
    return terminal(unavailable('malformed-response', false), {
      httpStatus: response.status,
    });
  }

  const record = isRecord(value) ? value : null;
  const baseResponse =
    record && isRecord(record.base_resp) ? record.base_resp : {};
  const providerStatus =
    typeof baseResponse.status_code === 'number'
      ? baseResponse.status_code
      : undefined;
  diagnostic({
    event: 'provider-response',
    surface: 'provider',
    attempt,
    elapsedMs: elapsedMs(),
    deadlineMs: options.timeoutMs,
    httpStatus: response.status,
    ...(providerStatus === undefined ? {} : { providerStatus }),
  });

  if (!response.ok) {
    const failure = providerFailure(
      response.status,
      baseResponse.status_msg ?? (record && record.error),
    );
    return terminal(unavailable(failure.reason, failure.retryable), {
      httpStatus: response.status,
      ...(providerStatus === undefined ? {} : { providerStatus }),
    });
  }
  if (!record) {
    return terminal(unavailable('malformed-response', false), {
      httpStatus: response.status,
    });
  }
  if (providerStatus) {
    const failure = providerFailure(providerStatus, baseResponse.status_msg);
    return terminal(unavailable(failure.reason, failure.retryable), {
      httpStatus: response.status,
      providerStatus,
    });
  }
  if (typeof record.structure_result !== 'string') {
    return terminal(unavailable('malformed-response', false), {
      httpStatus: response.status,
      ...(providerStatus === undefined ? {} : { providerStatus }),
    });
  }

  let structure: unknown;
  try {
    structure = JSON.parse(record.structure_result) as unknown;
  } catch {
    return terminal(unavailable('malformed-response', false), {
      httpStatus: response.status,
      ...(providerStatus === undefined ? {} : { providerStatus }),
    });
  }
  const timing = normalizeLyricTiming({
    version: 1,
    mode: 'minimax-section-asr',
    durationSeconds: record.audio_duration,
    segments: isRecord(structure) ? structure.segments : undefined,
  });
  if (!timing) {
    return terminal(unavailable('invalid-timing', false), {
      httpStatus: response.status,
      ...(providerStatus === undefined ? {} : { providerStatus }),
    });
  }
  return terminal(
    { status: 'ready', timing },
    {
      httpStatus: response.status,
      ...(providerStatus === undefined ? {} : { providerStatus }),
    },
  );
}
