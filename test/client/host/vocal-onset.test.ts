import { describe, expect, test } from 'vitest';

import {
  firstSustainedOnset,
  rmsEnvelope,
  vocalGateSeconds,
  VOCAL_ONSET_BASELINE_WINDOWS,
  VOCAL_ONSET_RISE_FACTOR,
  VOCAL_ONSET_SUSTAIN_WINDOWS,
  VOCAL_ONSET_WINDOW_MS,
} from '../../../src/client/host/vocal-onset.ts';
import type { TimelineEntry } from '../../../src/lyrics/lyric-sync.ts';

const SAMPLE_RATE = 8_000;

function sineBurst(
  seconds: number,
  burstStart: number,
  burstEnd: number,
): Float32Array {
  return Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, index) => {
    const time = index / SAMPLE_RATE;
    return time >= burstStart && time < burstEnd
      ? Math.sin(2 * Math.PI * 440 * time) * 0.6
      : 0;
  });
}

describe('vocal onset primitives', () => {
  test('builds one RMS value per non-overlapping window', () => {
    const envelope = rmsEnvelope(
      new Float32Array(SAMPLE_RATE).fill(0.5),
      SAMPLE_RATE,
      100,
    );
    expect(envelope).toHaveLength(10);
    expect(Array.from(envelope)).toEqual(
      expect.arrayContaining([expect.closeTo(0.5, 5)]),
    );
  });

  test('finds a sustained sine burst within one analysis window', () => {
    const burstAt = 1;
    const envelope = rmsEnvelope(
      sineBurst(2, burstAt, 1.5),
      SAMPLE_RATE,
      VOCAL_ONSET_WINDOW_MS,
    );
    const onset = firstSustainedOnset(envelope, VOCAL_ONSET_WINDOW_MS);
    expect(onset).not.toBeNull();
    expect(Math.abs((onset ?? 0) - burstAt)).toBeLessThanOrEqual(
      VOCAL_ONSET_WINDOW_MS / 1000,
    );
  });

  test('returns null for a stable noise floor', () => {
    const samples = Float32Array.from(
      { length: SAMPLE_RATE * 2 },
      (_, index) => (index % 2 ? 0.015 : -0.015),
    );
    expect(
      firstSustainedOnset(
        rmsEnvelope(samples, SAMPLE_RATE, VOCAL_ONSET_WINDOW_MS),
        VOCAL_ONSET_WINDOW_MS,
      ),
    ).toBeNull();
  });

  test('ignores an onset before the requested search slice', () => {
    const samples = sineBurst(2, 0.2, 0.6);
    const searchStart = SAMPLE_RATE;
    const searched = samples.subarray(searchStart);
    expect(
      firstSustainedOnset(
        rmsEnvelope(searched, SAMPLE_RATE, VOCAL_ONSET_WINDOW_MS),
        VOCAL_ONSET_WINDOW_MS,
      ),
    ).toBeNull();
  });

  test('exports the tunable defaults', () => {
    expect(VOCAL_ONSET_WINDOW_MS).toBe(20);
    expect(VOCAL_ONSET_BASELINE_WINDOWS).toBe(25);
    expect(VOCAL_ONSET_RISE_FACTOR).toBe(3);
    expect(VOCAL_ONSET_SUSTAIN_WINDOWS).toBe(5);
  });
});

describe('vocal gate policy', () => {
  const timeline: TimelineEntry[] = [
    { start: 0, end: 4, label: 'inst', sectionIndex: 0 },
    { start: 5, end: 25, label: 'verse', sectionIndex: 1 },
    { start: 25, end: 40, label: 'chorus', sectionIndex: 2 },
  ];

  test('applies only to the first mapped non-instrumental section', () => {
    expect(vocalGateSeconds(timeline, 7)).toBe(7);
  });

  test('clamps the gate to the section start and safe upper bound', () => {
    expect(vocalGateSeconds(timeline, 2)).toBe(5);
    expect(vocalGateSeconds(timeline, 20)).toBe(13);
    expect(
      vocalGateSeconds(
        [{ start: 3, end: 11, label: 'verse', sectionIndex: 0 }],
        20,
      ),
    ).toBe(7);
  });

  test('returns null when no detected onset or vocal section exists', () => {
    expect(vocalGateSeconds(timeline, null)).toBeNull();
    expect(
      vocalGateSeconds(
        [{ start: 0, end: 5, label: 'silence', sectionIndex: null }],
        2,
      ),
    ).toBeNull();
  });
});
