import type { IncomingMessage, ServerResponse } from 'node:http';

export interface LyricSheet {
  title: string;
  language: string;
  languageCode: string;
  nativeScriptName: string;
  isLatinScript: boolean;
  lyricsNative: string;
  lyricsRoman: string;
  prompt: string;
  usage: unknown;
}

export interface WriteLyricsInput {
  token: string;
  idea: string;
  vibe: string;
  language: string;
  signal: AbortSignal;
}

export type WriteLyrics = (input: WriteLyricsInput) => Promise<LyricSheet>;

export interface LyricistOptions {
  token?: string;
  idea?: string;
  vibe?: string;
  language?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface MiniMaxDataAudioResponse {
  data?: { audio?: unknown };
}

export interface MiniMaxNestedAudioResponse {
  audio?: { url?: unknown };
}

export interface MiniMaxDirectAudioResponse {
  audio?: unknown;
}

export type MiniMaxMusicResponse =
  | MiniMaxDataAudioResponse
  | MiniMaxNestedAudioResponse
  | MiniMaxDirectAudioResponse;

export interface SharedSongMetadata {
  title: string;
  language: string;
  nativeScriptName: string;
  isLatinScript: boolean;
  lyricsNative: string;
  lyricsRoman: string;
}

export interface CreateServerOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  writeLyrics?: WriteLyrics;
  shareBaseUrl?: string;
  shareSecret?: string;
}

export interface IssueShareTicketOptions {
  source?: unknown;
  expiresAt?: unknown;
  secret?: unknown;
}

export interface VerifyShareTicketOptions {
  now?: unknown;
  secret?: unknown;
}

export interface ShareTicketPayload {
  v: 1;
  source: string;
  expiresAt: number;
}

export interface VerifiedShareTicket {
  source: string;
  idempotencyKey: string;
}

export type VercelHandler = (req: IncomingMessage, res: ServerResponse) => void;
