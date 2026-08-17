import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createHttpTimingAnalysisPort,
  createTimingAnalysisController,
  type TimingAnalysisPort,
} from '../../../src/client/host/timing-analysis-controller.ts';
import type { TimingAnalysisOutcome } from '../../../src/timing/timing-analysis.ts';

const timing = {
  version: 1 as const,
  mode: 'minimax-section-asr' as const,
  durationSeconds: 30,
  segments: [
    { start: 0, end: 15, label: 'verse' as const },
    { start: 15, end: 30, label: 'chorus' as const },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function controller(port: TimingAnalysisPort, diagnostic = vi.fn()) {
  return createTimingAnalysisController({
    port,
    deadlineMs: 1_000,
    maxAttempts: 2,
    diagnostic,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TimingAnalysisController', () => {
  test('normalizes a ready result and exposes one terminal settlement', async () => {
    const port = {
      analyze: vi.fn(() =>
        Promise.resolve({ status: 'ready' as const, timing }),
      ),
    };
    const analysis = controller(port);

    await analysis.analyze({
      source: 'https://audio.test/song.mp3',
      token: 'secret',
    });

    expect(analysis.state()).toEqual({ status: 'ready', timing });
    expect(await analysis.settled()).toEqual({ status: 'ready', timing });
    expect(port.analyze).toHaveBeenCalledOnce();
  });

  test('retries one timeout then settles ready', async () => {
    vi.useFakeTimers();
    const calls: Array<ReturnType<typeof deferred<TimingAnalysisOutcome>>> = [];
    const port = {
      analyze: vi.fn(() => {
        const call = deferred<TimingAnalysisOutcome>();
        calls.push(call);
        return call.promise;
      }),
    };
    const diagnostic = vi.fn();
    const analysis = controller(port, diagnostic);
    const running = analysis.analyze({
      source: 'https://audio.test/song.mp3',
      token: 'secret',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(port.analyze).toHaveBeenCalledTimes(2);
    calls[1]?.resolve({ status: 'ready', timing });
    await running;

    expect(analysis.state()).toEqual({ status: 'ready', timing });
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'provider-retry',
        reason: 'timeout',
        attempt: 2,
      }),
    );
  });

  test('bounds retries and preserves the terminal reason', async () => {
    const port = {
      analyze: vi.fn(() =>
        Promise.resolve({
          status: 'unavailable' as const,
          reason: 'provider-busy' as const,
          retryable: true,
        }),
      ),
    };
    const analysis = controller(port);

    await analysis.analyze({
      source: 'https://audio.test/song.mp3',
      token: 'secret',
    });

    expect(port.analyze).toHaveBeenCalledTimes(2);
    expect(await analysis.settled()).toEqual({
      status: 'unavailable',
      reason: 'provider-busy',
    });
  });

  test('never retries a terminal category even if a malformed adapter marks it retryable', async () => {
    const port = {
      analyze: vi.fn(() =>
        Promise.resolve({
          status: 'unavailable' as const,
          reason: 'authentication' as const,
          retryable: true,
        }),
      ),
    };
    const analysis = controller(port);

    await analysis.analyze({
      source: 'https://audio.test/song.mp3',
      token: 'secret',
    });

    expect(port.analyze).toHaveBeenCalledOnce();
    expect(await analysis.settled()).toEqual({
      status: 'unavailable',
      reason: 'authentication',
    });
  });

  test('cancel resolves pending work and suppresses its stale result', async () => {
    const pending = deferred<TimingAnalysisOutcome>();
    const analysis = controller({ analyze: () => pending.promise });
    const running = analysis.analyze({
      source: 'https://audio.test/song.mp3',
      token: 'secret',
    });
    const settled = analysis.settled();

    analysis.cancel();
    pending.resolve({ status: 'ready', timing });
    await running;

    expect(await settled).toEqual({
      status: 'unavailable',
      reason: 'cancelled',
    });
    expect(analysis.state()).toEqual({
      status: 'unavailable',
      reason: 'cancelled',
    });
  });

  test('a replaced request cannot overwrite the newer terminal result', async () => {
    const first = deferred<TimingAnalysisOutcome>();
    const second = deferred<TimingAnalysisOutcome>();
    const port = {
      analyze: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const analysis = controller(port);
    const oldRun = analysis.analyze({
      source: 'https://audio.test/old.mp3',
      token: 'secret',
    });
    const newRun = analysis.analyze({
      source: 'https://audio.test/new.mp3',
      token: 'secret',
    });
    second.resolve({ status: 'ready', timing });
    await newRun;
    first.resolve({
      status: 'unavailable',
      reason: 'network',
      retryable: true,
    });
    await oldRun;

    expect(analysis.state()).toEqual({ status: 'ready', timing });
  });

  test('HTTP adapter sends request-only secrets and accepts discriminated outcomes', async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(Response.json({ status: 'ready', timing })),
    );
    const port = createHttpTimingAnalysisPort(fetcher);
    const signal = new AbortController().signal;

    await expect(
      port.analyze({
        source: 'https://audio.test/song.mp3',
        token: 'secret',
        attempt: 1,
        signal,
      }),
    ).resolves.toEqual({ status: 'ready', timing });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/analyze-timing',
      expect.objectContaining({
        method: 'POST',
        signal,
        body: JSON.stringify({
          source: 'https://audio.test/song.mp3',
          token: 'secret',
          attempt: 1,
        }),
      }),
    );
  });
});
