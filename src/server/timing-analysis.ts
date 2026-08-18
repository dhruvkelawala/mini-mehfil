import { normalizeLyricTiming } from '../lyrics/lyric-sync.ts';
import {
  isNumber,
  isRecord,
  isString,
  type JsonValue,
} from '../room/primitives.ts';
import {
  type TimingAnalysisOutcome,
  type TimingFailureReason,
} from '../timing/timing-analysis.ts';

export interface TimingAnalysisFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface AnalyzeMiniMaxTimingInput {
  source: string;
  token: string;
}

export interface AnalyzeMiniMaxTimingOptions {
  apiBase: string;
  fetchImpl: TimingAnalysisFetch;
  timeoutMs: number;
  /** Test-only seam for a loopback replay provider. */
  allowLocalHttpSource?: boolean;
}

function unavailable(
  reason: TimingFailureReason,
  retryable: boolean,
): TimingAnalysisOutcome {
  return { status: 'unavailable', reason, retryable };
}

function safeAnalysisSource(
  value: string,
  allowLocalHttpSource = false,
): boolean {
  try {
    const url = new URL(value);
    const loopbackHttp =
      allowLocalHttpSource &&
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    return (
      (url.protocol === 'https:' || loopbackHttp) &&
      !url.username &&
      !url.password &&
      value.length <= 32 * 1024
    );
  } catch {
    return false;
  }
}

type TimingFailure = {
  reason: TimingFailureReason;
  retryable: boolean;
};

function providerFailure(
  status: number,
  message: JsonValue | undefined,
): TimingFailure {
  const text = isString(message) ? message : '';
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
  if (!safeAnalysisSource(input.source, options.allowLocalHttpSource))
    return unavailable('unsupported-source', false);

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
    const name = error instanceof Error ? error.name : '';
    const timedOut = name === 'AbortError' || name === 'TimeoutError';
    return unavailable(timedOut ? 'timeout' : 'network', true);
  }

  let value: JsonValue | undefined;
  try {
    value = JSON.parse(await response.text());
  } catch {
    if (!response.ok) {
      const failure = providerFailure(response.status, '');
      return unavailable(failure.reason, failure.retryable);
    }
    return unavailable('malformed-response', false);
  }

  const record = isRecord(value) ? value : null;
  const baseResponse =
    record && isRecord(record.base_resp) ? record.base_resp : {};
  const statusCode = baseResponse.status_code;
  const providerStatus = isNumber(statusCode) ? statusCode : undefined;

  if (!response.ok) {
    const failure = providerFailure(
      response.status,
      baseResponse.status_msg ?? record?.error,
    );
    return unavailable(failure.reason, failure.retryable);
  }
  if (!record) return unavailable('malformed-response', false);
  if (providerStatus) {
    const failure = providerFailure(providerStatus, baseResponse.status_msg);
    return unavailable(failure.reason, failure.retryable);
  }
  const structureResult = record.structure_result;
  if (!isString(structureResult))
    return unavailable('malformed-response', false);

  let structure: JsonValue | undefined;
  try {
    structure = JSON.parse(structureResult);
  } catch {
    return unavailable('malformed-response', false);
  }
  const durationSeconds = record.audio_duration;
  const timing = normalizeLyricTiming({
    version: 1,
    mode: 'minimax-section-asr',
    durationSeconds: durationSeconds ?? null,
    segments: isRecord(structure) ? (structure.segments ?? null) : null,
  });
  if (!timing) return unavailable('invalid-timing', false);
  return { status: 'ready', timing };
}
