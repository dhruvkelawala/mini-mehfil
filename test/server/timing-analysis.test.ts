import { describe, expect, test } from 'vitest';

import { analyzeMiniMaxTiming } from '../../src/server/timing-analysis.ts';

const input = {
  source: 'https://cdn.minimax.test/song.mp3',
  token: 'sk-private-analysis-token',
};

const options = (fetchImpl: typeof fetch) => ({
  apiBase: 'https://api.minimax.test',
  fetchImpl,
  timeoutMs: 180_000,
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

  test('a provider status failure is classified from its status message', async () => {
    const outcome = await analyzeMiniMaxTiming(
      input,
      options(() =>
        Promise.resolve(
          Response.json({
            base_resp: {
              status_code: 1000,
              status_msg: 'unknown error, download audio_url failed',
            },
          }),
        ),
      ),
    );
    expect(outcome).toEqual({
      status: 'unavailable',
      reason: 'provider-http',
      retryable: true,
    });
  });
});
