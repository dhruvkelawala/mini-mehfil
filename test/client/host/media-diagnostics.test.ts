import { expect, test } from 'vitest';

import {
  mediaSnapshot,
  normalizeDiagnosticError,
  redactDiagnosticUrl,
  safeDiagnosticDetails,
} from '../../../src/client/host/media-diagnostics.ts';

const BASE = 'https://preview.example.app/?mediaDebug=1';

test('signed media URLs are reduced to their origin', () => {
  expect(
    redactDiagnosticUrl(
      'https://cdn.example.com/private/song.mp3?AccessKey=secret&Expires=999#fragment',
      BASE,
    ),
  ).toBe('https://cdn.example.com/[redacted-path]');
});
test('same-origin diagnostic endpoints keep only their pathname', () => {
  expect(redactDiagnosticUrl('/api/generate?token=secret', BASE)).toBe(
    '/api/generate',
  );
});
test('errors retain actionable details without leaking signed URLs', () => {
  const error = new Error(
    'Failed https://cdn.example.com/song.mp3?signature=secret',
  );
  error.name = 'NotSupportedError';
  const normalized = normalizeDiagnosticError(error, BASE);
  expect(normalized.name).toBe('NotSupportedError');
  expect(normalized.message).toBe(
    'Failed https://cdn.example.com/[redacted-path]',
  );
  expect(JSON.stringify(normalized)).not.toMatch(/signature|secret/);
});
test('sensitive diagnostic keys are always redacted', () => {
  expect(
    safeDiagnosticDetails(
      {
        token: 'sk-secret',
        requestBody: { idea: 'private' },
        prompt: 'private',
        status: 200,
      },
      BASE,
    ),
  ).toEqual({
    token: '[redacted]',
    requestBody: '[redacted]',
    prompt: '[redacted]',
    status: 200,
  });
});
test('media snapshots expose WebKit state without exposing its source URL', () => {
  const snapshot = mediaSnapshot(
    {
      currentSrc: 'https://cdn.example.com/private/song.mp3?signature=secret',
      src: '',
      paused: true,
      ended: false,
      seeking: false,
      currentTime: 0,
      duration: 6.125,
      readyState: 1,
      networkState: 2,
      error: { code: 4, message: 'Unsupported source' },
    } as unknown as HTMLMediaElement,
    BASE,
  );
  expect(snapshot).toEqual({
    currentSrc: 'https://cdn.example.com/[redacted-path]',
    paused: true,
    ended: false,
    seeking: false,
    currentTime: 0,
    duration: 6.125,
    readyState: '1 HAVE_METADATA',
    networkState: '2 NETWORK_LOADING',
    error: { code: 4, message: 'Unsupported source' },
  });
});
