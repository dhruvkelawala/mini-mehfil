import { describe, expect, test, vi } from 'vitest';

import { analyzeMiniMaxTiming } from '../../src/server/timing-analysis.ts';
import {
  emitTimingDiagnostic,
  type TimingDiagnostic,
} from '../../src/timing/timing-analysis.ts';

const input = {
  source: 'https://cdn.minimax.test/song.mp3',
  token: 'sk-private-analysis-token',
  attempt: 2,
};

const options = (fetchImpl: typeof fetch) => ({
  apiBase: 'https://api.minimax.test',
  fetchImpl,
  timeoutMs: 180_000,
  diagnostic: vi.fn<(diagnostic: TimingDiagnostic) => void>(),
});

describe('MiniMax timing analysis adapter', () => {
  test.each([
    {
      name: 'network failure',
      fetcher: () => Promise.reject(new TypeError('socket failed')),
      expected: { reason: 'network', retryable: true },
    },
    {
      name: 'request timeout HTTP status',
      fetcher: () => Promise.resolve(new Response('', { status: 408 })),
      expected: { reason: 'provider-http', retryable: true },
    },
    {
      name: 'rate limit',
      fetcher: () => Promise.resolve(new Response('', { status: 429 })),
      expected: { reason: 'provider-busy', retryable: true },
    },
    {
      name: 'provider outage',
      fetcher: () => Promise.resolve(new Response('', { status: 503 })),
      expected: { reason: 'provider-http', retryable: true },
    },
    {
      name: 'authentication failure',
      fetcher: () => Promise.resolve(new Response('', { status: 403 })),
      expected: { reason: 'authentication', retryable: false },
    },
  ])('$name is classified without throwing', async ({ fetcher, expected }) => {
    const outcome = await analyzeMiniMaxTiming(input, options(fetcher));
    expect(outcome).toEqual({ status: 'unavailable', ...expected });
  });

  test('invalid normalized timing is terminal', async () => {
    const outcome = await analyzeMiniMaxTiming(
      input,
      options(() =>
        Promise.resolve(
          Response.json({
            base_resp: { status_code: 0, status_msg: 'success' },
            audio_duration: 10,
            structure_result: JSON.stringify({
              segments: [{ start: 0, end: 12, label: 'verse' }],
            }),
          }),
        ),
      ),
    );
    expect(outcome).toEqual({
      status: 'unavailable',
      reason: 'invalid-timing',
      retryable: false,
    });
  });

  test('provider status failure preserves a sanitized status message', async () => {
    const opts = options(() =>
      Promise.resolve(
        Response.json({
          base_resp: {
            status_code: 1000,
            status_msg:
              'unknown error, download https://cdn.minimax.test/signed/abcdefghijklmnopqrstuvwxyz123456?sig=sk-secret failed',
          },
        }),
      ),
    );
    const outcome = await analyzeMiniMaxTiming(input, opts);
    expect(outcome).toEqual({
      status: 'unavailable',
      reason: 'provider-http',
      retryable: true,
    });
    const terminal = opts.diagnostic.mock.calls
      .map(([diagnostic]) => diagnostic)
      .find((diagnostic) => diagnostic.event === 'provider-terminal');
    expect(terminal?.providerStatus).toBe(1000);
    expect(terminal?.providerMessage).toBe(
      'unknown error, download https://cdn.minimax.test/signed/abcdefghijklmnopqrstuvwxyz123456?sig=sk-secret failed',
    );
  });

  test('emitted provider messages scrub URLs and opaque values', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    emitTimingDiagnostic({
      event: 'provider-terminal',
      surface: 'provider',
      reason: 'provider-http',
      providerMessage:
        'unknown error, download https://cdn.minimax.test/signed/abc?token=sk-secret failed for opaquecredential0123456789abcdef',
    });
    expect(info).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(info.mock.calls[0]);
    expect(serialized).toContain('unknown error, download <url> failed');
    expect(serialized).not.toMatch(/cdn\.minimax|sk-secret|opaquecredential/);
    info.mockRestore();
  });

  test('diagnostic runtime guard drops secrets and arbitrary provider data', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    emitTimingDiagnostic({
      event: 'provider-terminal',
      surface: 'provider',
      reason: 'ready',
      attempt: 1,
      segmentCount: 3,
      token: input.token,
      source: input.source,
      transcript: 'private transcript',
      traceId: 'provider-trace',
    } as TimingDiagnostic & Record<string, unknown>);

    expect(info).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(info.mock.calls[0]);
    expect(serialized).toContain('[TIMING-DIAGNOSTIC]');
    expect(serialized).toContain('segmentCount');
    expect(serialized).not.toMatch(
      /private-analysis-token|cdn\.minimax|private transcript|provider-trace/,
    );
    info.mockRestore();
  });
});
