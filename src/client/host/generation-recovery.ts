import {
  isString,
  randomBase64Url,
  type JsonRecord,
  type JsonValue,
} from '../../room/primitives.ts';
import { isRecord, type LyricsSheet } from '../../room/protocol.ts';

export const GENERATION_STORAGE_KEY = 'mini-mehfil:generation:v1';
export const JOB_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const TTL_MS = 24 * 60 * 60 * 1000;
const BACKOFF = [2_000, 3_000, 5_000] as const;

export type HostLyrics = LyricsSheet & {
  languageCode: string;
  prompt: string;
};

export type RoomGenerationContext = {
  kind: 'room-recording';
  roomId: string;
  requestId: string;
};

export type GenerationContext = RoomGenerationContext | null;

export interface PendingGeneration {
  version: 1;
  jobId: string;
  createdAt: string;
  lyricSheet: HostLyrics;
  context?: GenerationContext;
}

export interface ActiveGeneration extends PendingGeneration {
  run: number;
  attempt: number;
}

export interface StatusResponse {
  ok: boolean;
  status: number;
  value: JsonRecord;
}

export interface RecoveryCoordinator {
  createJobId(): string;
  save(value: {
    jobId: string;
    lyricSheet: HostLyrics;
    context?: GenerationContext;
  }): PendingGeneration;
  read(): PendingGeneration | null;
  clear(): void;
  start(pending: PendingGeneration, run: number): boolean;
  resume(): void;
  cancel(): void;
  current(): ActiveGeneration | null;
}

interface CoordinatorOptions {
  storage?: Storage | null;
  now?: () => number;
  cryptoSource?: Crypto | null;
  visibility?: () => boolean;
  schedule?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
  fetchStatus?: (jobId: string) => Promise<StatusResponse>;
  onRequest?: (pending: ActiveGeneration) => void;
  onResponse?: (response: StatusResponse, pending: ActiveGeneration) => void;
  onPending?: (value: JsonRecord, pending: ActiveGeneration) => void;
  onComplete?: (value: JsonRecord, pending: ActiveGeneration) => void;
  onFailed?: (value: JsonRecord, pending: ActiveGeneration) => void;
  onExpired?: (value: JsonRecord, pending: ActiveGeneration) => void;
  onRetryable?: (
    error: { status: number; message: string },
    pending: ActiveGeneration,
  ) => void;
}

function cleanSheet(value: JsonValue | undefined): HostLyrics | null {
  if (!isRecord(value)) return null;
  const sheet: HostLyrics = {
    title: isString(value.title) ? value.title : '',
    language: isString(value.language) ? value.language : '',
    languageCode: isString(value.languageCode) ? value.languageCode : '',
    nativeScriptName: isString(value.nativeScriptName)
      ? value.nativeScriptName
      : '',
    isLatinScript: value.isLatinScript === true,
    lyricsNative: isString(value.lyricsNative) ? value.lyricsNative : '',
    lyricsRoman: isString(value.lyricsRoman) ? value.lyricsRoman : '',
    prompt: isString(value.prompt) ? value.prompt : '',
  };
  return sheet.title && (sheet.lyricsNative || sheet.lyricsRoman)
    ? sheet
    : null;
}

function cleanContext(
  value: JsonValue | undefined,
): GenerationContext | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value.kind !== 'room-recording') return undefined;
  const roomId = value.roomId;
  const requestId = value.requestId;
  if (
    !isString(roomId) ||
    !/^[A-Za-z0-9_-]{8}$/.test(roomId) ||
    !isString(requestId) ||
    !requestId ||
    requestId.length > 120
  ) {
    return undefined;
  }
  return {
    kind: 'room-recording',
    roomId,
    requestId,
  };
}

function canGetRandomValues(source: Crypto): source is Crypto & {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
} {
  return typeof source.getRandomValues === 'function';
}

export function createJobId(cryptoSource: Crypto = crypto): string {
  if (!canGetRandomValues(cryptoSource))
    throw new Error('Secure randomness is unavailable.');
  return randomBase64Url(18, cryptoSource);
}

export function savePendingGeneration(
  storage: Storage,
  jobId: string,
  lyricSheet: HostLyrics,
  now: () => number = Date.now,
  context: GenerationContext = null,
): PendingGeneration {
  const clean = cleanSheet(lyricSheet);
  const cleanGenerationContext = cleanContext(context);
  if (
    !JOB_PATTERN.test(jobId) ||
    !clean ||
    cleanGenerationContext === undefined
  )
    throw new Error('A valid pending generation is required.');
  const record: PendingGeneration = {
    version: 1,
    jobId,
    createdAt: new Date(now()).toISOString(),
    lyricSheet: clean,
    context: cleanGenerationContext,
  };
  storage.setItem(GENERATION_STORAGE_KEY, JSON.stringify(record));
  return record;
}

export function clearPendingGeneration(storage: Storage): void {
  try {
    storage.removeItem(GENERATION_STORAGE_KEY);
  } catch {
    /* Recovery is best-effort. */
  }
}

export function readPendingGeneration(
  storage: Storage,
  now: () => number = Date.now,
): PendingGeneration | null {
  let value: JsonValue | undefined;
  try {
    value = JSON.parse(storage.getItem(GENERATION_STORAGE_KEY) ?? 'null');
  } catch {
    clearPendingGeneration(storage);
    return null;
  }
  const sheet = isRecord(value) ? cleanSheet(value.lyricSheet) : null;
  const context = isRecord(value) ? cleanContext(value.context) : undefined;
  const created = isRecord(value) ? Date.parse(String(value.createdAt)) : NaN;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !JOB_PATTERN.test(String(value.jobId)) ||
    !sheet ||
    context === undefined ||
    !Number.isFinite(created) ||
    created + TTL_MS <= now()
  ) {
    clearPendingGeneration(storage);
    return null;
  }
  return {
    version: 1,
    jobId: String(value.jobId),
    createdAt: new Date(created).toISOString(),
    lyricSheet: sheet,
    context,
  };
}

export function createRecoveryCoordinator(
  options: CoordinatorOptions = {},
): RecoveryCoordinator {
  const storage = options.storage ?? null;
  const now = options.now ?? Date.now;
  const cryptoSource =
    options.cryptoSource ?? (!('crypto' in globalThis) ? null : crypto);
  const visibility =
    options.visibility ??
    (() =>
      !('document' in globalThis) || document.visibilityState === 'visible');
  const schedule = options.schedule ?? setTimeout;
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;
  const fetchStatus =
    options.fetchStatus ??
    (async (jobId: string): Promise<StatusResponse> => {
      const response = await fetch(
        `/api/generation-status?id=${encodeURIComponent(jobId)}`,
      );
      let value: JsonValue | undefined;
      try {
        value = await response.json();
      } catch {
        value = { error: 'The server returned an unreadable response.' };
      }
      return {
        ok: response.ok,
        status: response.status,
        value: isRecord(value) ? value : {},
      };
    });
  let active: ActiveGeneration | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let serial = 0;

  const clearTimer = () => {
    if (timer !== null) cancelSchedule(timer);
    timer = null;
  };
  const stop = () => {
    clearTimer();
    active = null;
    inFlight = false;
    serial += 1;
  };
  const poll = async (): Promise<void> => {
    timer = null;
    if (!active || inFlight || !visibility()) return;
    const snapshot = active;
    const pollSerial = serial;
    inFlight = true;
    options.onRequest?.(snapshot);
    let response: StatusResponse;
    try {
      response = await fetchStatus(snapshot.jobId);
    } catch (error) {
      response = {
        ok: false,
        status: 0,
        value: {
          error: error instanceof Error ? error.message : 'Network error.',
        },
      };
    }
    inFlight = false;
    if (!active || active !== snapshot || pollSerial !== serial) return;
    options.onResponse?.(response, snapshot);
    if (!response.ok) {
      if (response.status === 404) {
        stop();
        options.onExpired?.(response.value, snapshot);
      } else
        options.onRetryable?.(
          {
            status: response.status,
            message: isString(response.value.error)
              ? response.value.error
              : 'Recording recovery is temporarily unavailable.',
          },
          snapshot,
        );
      return;
    }
    if (response.value.status === 'complete') {
      stop();
      options.onComplete?.(response.value, snapshot);
      return;
    }
    if (response.value.status === 'failed') {
      stop();
      options.onFailed?.(response.value, snapshot);
      return;
    }
    options.onPending?.(response.value, snapshot);
    const delay = BACKOFF[Math.min(snapshot.attempt, BACKOFF.length - 1)];
    snapshot.attempt += 1;
    timer = schedule(() => void poll(), delay ?? 5_000);
  };

  return {
    createJobId() {
      if (!cryptoSource) throw new Error('Secure randomness is unavailable.');
      return createJobId(cryptoSource);
    },
    save(value) {
      if (!storage) throw new Error('A valid pending generation is required.');
      return savePendingGeneration(
        storage,
        value.jobId,
        value.lyricSheet,
        now,
        value.context ?? null,
      );
    },
    read() {
      return storage ? readPendingGeneration(storage, now) : null;
    },
    clear() {
      if (storage) clearPendingGeneration(storage);
    },
    start(pending, run) {
      if (!JOB_PATTERN.test(pending.jobId)) return false;
      if (active?.jobId === pending.jobId && active.run === run) return true;
      stop();
      active = { ...pending, run, attempt: 0 };
      void poll();
      return true;
    },
    resume() {
      if (active && !inFlight && timer === null) void poll();
    },
    cancel: stop,
    current: () => active,
  };
}
