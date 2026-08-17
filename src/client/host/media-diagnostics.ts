import { createSignal } from 'solid-js';

export interface MediaDiagnostics {
  available: () => boolean;
  visible: () => boolean;
  headline: () => string;
  report: () => string;
  recordFailure(error: unknown, media?: HTMLMediaElement | null): void;
  open(): void;
  close(): void;
  clear(): void;
}

const READY_STATES = [
  'HAVE_NOTHING',
  'HAVE_METADATA',
  'HAVE_CURRENT_DATA',
  'HAVE_FUTURE_DATA',
  'HAVE_ENOUGH_DATA',
] as const;
const NETWORK_STATES = [
  'NETWORK_EMPTY',
  'NETWORK_IDLE',
  'NETWORK_LOADING',
  'NETWORK_NO_SOURCE',
] as const;

export function redactDiagnosticUrl(
  value: string,
  baseUrl = location.href,
): string {
  try {
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    return url.origin === base.origin
      ? url.pathname
      : `${url.origin}/[redacted-path]`;
  } catch {
    return '[redacted url]';
  }
}

export function normalizeDiagnosticError(
  error: unknown,
  baseUrl: string,
): { name: string; message: string; code?: number; stack?: string } {
  const source =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : 'Unknown error');
  const redact = (value: string) =>
    value.replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
      redactDiagnosticUrl(url, baseUrl),
    );
  const code =
    'code' in source && typeof source.code === 'number'
      ? source.code
      : undefined;
  return {
    name: source.name || 'Error',
    message: redact(source.message),
    ...(code === undefined ? {} : { code }),
    ...(source.stack ? { stack: redact(source.stack) } : {}),
  };
}

export function safeDiagnosticDetails(
  value: unknown,
  baseUrl: string,
  key = '',
): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (/token|authorization|cookie|lyrics|prompt|payload|requestBody/i.test(key))
    return '[redacted]';
  if (value instanceof Error) return normalizeDiagnosticError(value, baseUrl);
  if (typeof value === 'string')
    return value.replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
      redactDiagnosticUrl(url, baseUrl),
    );
  if (Array.isArray(value))
    return value.map((item) => safeDiagnosticDetails(item, baseUrl));
  if (typeof value === 'object' && value)
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        safeDiagnosticDetails(child, baseUrl, childKey),
      ]),
    );
  return typeof value === 'symbol'
    ? (value.description ?? '[symbol]')
    : `[${typeof value}]`;
}

export function mediaSnapshot(
  media: HTMLMediaElement | null,
  baseUrl: string,
): Record<string, unknown> | null {
  if (!media) return null;
  const error = media.error;
  return {
    currentSrc: redactDiagnosticUrl(
      media.currentSrc || media.src || '',
      baseUrl,
    ),
    paused: Boolean(media.paused),
    ended: Boolean(media.ended),
    seeking: Boolean(media.seeking),
    currentTime: Number.isFinite(media.currentTime)
      ? Number(media.currentTime.toFixed(3))
      : null,
    duration: Number.isFinite(media.duration)
      ? Number(media.duration.toFixed(3))
      : null,
    readyState: `${media.readyState} ${READY_STATES[media.readyState] ?? 'UNKNOWN'}`,
    networkState: `${media.networkState} ${NETWORK_STATES[media.networkState] ?? 'UNKNOWN'}`,
    error: error
      ? {
          code: error.code,
          message: String(error.message || '').replace(
            /https?:\/\/[^\s"'<>]+/gi,
            (url) => redactDiagnosticUrl(url, baseUrl),
          ),
        }
      : null,
  };
}

function safeMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'Playback was rejected.';
  return message
    .replace(/https?:\/\/[^\s)]+/gi, (url) => redactDiagnosticUrl(url))
    .replace(
      /\b(token|authorization|secret|lyrics|requestBody)\b\s*[:=]\s*[^,\s}]+/gi,
      '$1=[redacted]',
    );
}

export function createMediaDiagnostics(): MediaDiagnostics {
  const [available] = createSignal(
    typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('mediaDebug') === '1',
  );
  const [visible, setVisible] = createSignal(false);
  const [headline, setHeadline] = createSignal(
    'Media diagnostics are recording',
  );
  const [report, setReport] = createSignal('');
  return {
    available,
    visible,
    headline,
    report,
    recordFailure(error, media = null) {
      if (!available()) return;
      const message = safeMessage(error);
      setHeadline('Playback stopped for evidence');
      setReport(
        JSON.stringify(
          {
            type: 'playback-failure',
            message,
            media: mediaSnapshot(media, location.href),
          },
          null,
          2,
        ),
      );
      setVisible(true);
    },
    open: () => {
      if (available()) setVisible(true);
    },
    close: () => setVisible(false),
    clear() {
      setReport('');
      setHeadline('Media diagnostics are recording');
      setVisible(false);
    },
  };
}
