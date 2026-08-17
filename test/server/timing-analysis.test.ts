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

  // Real provider replies observed on 2026-08-17. A non-zero base_resp status
  // is a failure even though the HTTP status is 200.
  test.each([
    {
      name: 'an unrecognized status falls back to the numeric class',
      status_code: 1000,
      status_msg: 'unknown error, download audio_url failed',
      expected: { reason: 'provider-http', retryable: true },
    },
    {
      name: 'an authentication message is terminal',
      status_code: 1004,
      status_msg:
        "login fail: Please carry the API secret key in the 'Authorization' field",
      expected: { reason: 'authentication', retryable: false },
    },
    {
      name: 'a busy message stays retryable',
      status_code: 1002,
      status_msg: 'server is busy, please try again',
      expected: { reason: 'provider-busy', retryable: true },
    },
  ])('$name', async ({ status_code, status_msg, expected }) => {
    const outcome = await analyzeMiniMaxTiming(
      input,
      options(() =>
        Promise.resolve(
          Response.json({ base_resp: { status_code, status_msg } }),
        ),
      ),
    );
    expect(outcome).toEqual({ status: 'unavailable', ...expected });
  });
});
