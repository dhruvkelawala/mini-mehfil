import { createRoot } from 'solid-js';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createShareLabel } from '../../../src/client/shared/share-label.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('share label', () => {
  test('returns an outcome to the idle label so the button never looks stuck', () => {
    vi.useFakeTimers();
    createRoot((dispose) => {
      const label = createShareLabel();
      expect(label.label()).toBe('Share');

      label.settle('Copied');
      expect(label.label()).toBe('Copied');
      vi.advanceTimersByTime(2_399);
      expect(label.label()).toBe('Copied');
      vi.advanceTimersByTime(1);
      expect(label.label()).toBe('Share');
      dispose();
    });
  });

  test('holds an in-flight step until the outcome replaces it', () => {
    vi.useFakeTimers();
    createRoot((dispose) => {
      const label = createShareLabel();
      label.hold('Sharing');
      vi.advanceTimersByTime(10_000);
      expect(label.label()).toBe('Sharing');

      label.settle('Copied');
      vi.advanceTimersByTime(2_400);
      expect(label.label()).toBe('Share');
      dispose();
    });
  });

  test('a second copy restarts the wait rather than inheriting the first', () => {
    vi.useFakeTimers();
    createRoot((dispose) => {
      const label = createShareLabel();
      label.settle('Copied');
      vi.advanceTimersByTime(2_000);
      label.settle('Copied');
      vi.advanceTimersByTime(2_000);
      expect(label.label()).toBe('Copied');
      vi.advanceTimersByTime(400);
      expect(label.label()).toBe('Share');
      dispose();
    });
  });

  test('reset drops a pending revert with the owning view', () => {
    vi.useFakeTimers();
    createRoot((dispose) => {
      const label = createShareLabel();
      label.settle('Copied');
      label.reset();
      expect(label.label()).toBe('Share');
      expect(vi.getTimerCount()).toBe(0);
      dispose();
    });
  });
});
