import type { LyricsSheet } from '../../room/protocol.ts';

export const GENERATION_STORAGE_KEY = 'mini-mehfil:generation:v1';
const JOB_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export interface HostLyrics extends LyricsSheet {
  languageCode: string;
  prompt: string;
}

export interface PendingGeneration {
  version: 1;
  jobId: string;
  createdAt: string;
  lyricSheet: HostLyrics;
}

export function createJobId(cryptoSource: Crypto = crypto): string {
  const bytes = new Uint8Array(18);
  cryptoSource.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function savePendingGeneration(
  storage: Storage,
  jobId: string,
  lyricSheet: HostLyrics,
): PendingGeneration {
  if (!JOB_PATTERN.test(jobId))
    throw new Error('A valid pending generation is required.');
  const record: PendingGeneration = {
    version: 1,
    jobId,
    createdAt: new Date().toISOString(),
    lyricSheet,
  };
  storage.setItem(GENERATION_STORAGE_KEY, JSON.stringify(record));
  return record;
}

export function clearPendingGeneration(storage: Storage): void {
  storage.removeItem(GENERATION_STORAGE_KEY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readPendingGeneration(
  storage: Storage,
): PendingGeneration | null {
  let value: unknown;
  try {
    value = JSON.parse(
      storage.getItem(GENERATION_STORAGE_KEY) ?? 'null',
    ) as unknown;
  } catch {
    clearPendingGeneration(storage);
    return null;
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !JOB_PATTERN.test(String(value.jobId))
  ) {
    clearPendingGeneration(storage);
    return null;
  }
  const sheet = value.lyricSheet;
  if (
    !isRecord(sheet) ||
    typeof sheet.title !== 'string' ||
    typeof sheet.language !== 'string' ||
    typeof sheet.languageCode !== 'string' ||
    typeof sheet.nativeScriptName !== 'string' ||
    typeof sheet.isLatinScript !== 'boolean' ||
    typeof sheet.lyricsNative !== 'string' ||
    typeof sheet.lyricsRoman !== 'string' ||
    typeof sheet.prompt !== 'string' ||
    typeof value.createdAt !== 'string' ||
    Date.parse(value.createdAt) + 86_400_000 <= Date.now()
  ) {
    clearPendingGeneration(storage);
    return null;
  }
  return {
    version: 1,
    jobId: String(value.jobId),
    createdAt: value.createdAt,
    lyricSheet: {
      title: sheet.title,
      language: sheet.language,
      languageCode: sheet.languageCode,
      nativeScriptName: sheet.nativeScriptName,
      isLatinScript: sheet.isLatinScript,
      lyricsNative: sheet.lyricsNative,
      lyricsRoman: sheet.lyricsRoman,
      prompt: sheet.prompt,
    },
  };
}
