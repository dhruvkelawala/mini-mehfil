import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { isDirectEntry, parseTcpPort } from '../config/runtime.ts';
import { normalizeLyricTiming } from '../lyrics/lyric-sync.ts';
import { isRoomId } from '../room/primitives.ts';
import { isRecord } from '../room/protocol.ts';
import type { LyricsResult, WriteLyricsOptions } from './lyricist.ts';
import { analyzeMiniMaxTiming } from './timing-analysis.ts';
import { type TimingAnalysisOutcome } from '../timing/timing-analysis.ts';

const DEFAULT_STATIC_ROOT = path.resolve(process.cwd(), 'dist/host');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SHARE_AUDIO_BYTES = 10 * 1024 * 1024;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const RECOVERY_TIMEOUT_MS = 15 * 1000;
const GENERATION_TIMEOUT_MS = 4 * 60 * 1000;
export const ANALYSIS_TIMEOUT_MS = 180 * 1000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

type JsonRecord = Record<string, unknown>;
type HttpError = Error & { status?: number; code?: string };

export interface ServerOptions {
  apiBase?: string;
  fetchImpl?: ServerFetch;
  writeLyrics?: (
    options: WriteLyricsOptions,
  ) => Promise<LyricsResult> | LyricsResult;
  shareBaseUrl?: string;
  publicBaseUrl?: string;
  shareSecret?: string;
  vercelProjectProductionUrl?: string;
  generationTimeoutMs?: number;
  analysisTimeoutMs?: number;
  roomTimeoutMs?: number;
  staticRoot?: string;
  /** Test-only seam for a loopback replay provider. Never enabled from env. */
  allowLocalHttpAudioSource?: boolean;
}

export type ServerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function errorDetails(error: unknown): HttpError {
  return error instanceof Error ? error : new Error('Unexpected server error.');
}

function parseJsonRecord(text: string): JsonRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: http.ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(
  req: http.IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(
          Object.assign(new Error('Request is too large'), { status: 413 }),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        );
        if (!isRecord(parsed)) throw new Error('Invalid JSON');
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function audioSource(
  result: JsonRecord,
  allowLocalHttpAudioSource = false,
): string | null {
  const data = isRecord(result.data) ? result.data : {};
  const audio = isRecord(result.audio) ? result.audio : {};
  const source = data.audio || audio.url || result.audio;
  if (typeof source !== 'string' || !source || source.length > 32 * 1024)
    return null;
  if (
    /^(?:0x)?[0-9a-f]+$/i.test(source) &&
    source.replace(/^0x/i, '').length % 2 === 0
  )
    return source;
  try {
    const url = new URL(source);
    const loopbackHttp =
      allowLocalHttpAudioSource &&
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    return (url.protocol === 'https:' || loopbackHttp) &&
      !url.username &&
      !url.password
      ? source
      : null;
  } catch {
    return null;
  }
}

async function readLimitedBody(
  response: Response,
  limit: number,
): Promise<Buffer> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > limit)
    throw Object.assign(
      new Error('The recording is larger than the 10 MB sharing limit.'),
      { status: 413 },
    );
  if (!response.body) return Buffer.alloc(0);
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const read = await reader.read();
    if (read.done) break;
    const value = read.value;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Object.assign(
        new Error('The recording is larger than the 10 MB sharing limit.'),
        { status: 413 },
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function decodeAudioSource(
  source: string,
  allowLocalHttpAudioSource = false,
): Buffer | null {
  try {
    const url = new URL(source);
    if (
      url.protocol === 'https:' ||
      (allowLocalHttpAudioSource &&
        url.protocol === 'http:' &&
        (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))
    )
      return null;
  } catch {
    // Inline-hex decoding follows.
  }
  const hex = source.replace(/^0x/i, '');
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex))
    throw Object.assign(new Error('The finished recording is unavailable.'), {
      status: 400,
    });
  const audio = Buffer.from(hex, 'hex');
  if (audio.length > MAX_SHARE_AUDIO_BYTES)
    throw Object.assign(
      new Error('The recording is larger than the 10 MB sharing limit.'),
      { status: 413 },
    );
  return audio;
}

function normalizeShareBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    const localHttp =
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (url.protocol !== 'https:' && !localHttp) return '';
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '')
    )
      return '';
    return url.origin;
  } catch {
    return '';
  }
}

function completedGeneration(record: JsonRecord): JsonRecord {
  const result: JsonRecord = {
    jobId: record.jobId,
    status: 'complete',
    data: { audio: record.source },
    share_ref: record.jobId,
  };
  if (record.traceId) result.trace_id = record.traceId;
  const timing = normalizeLyricTiming(record.lyricTiming);
  if (timing) result.lyric_timing = timing;
  return result;
}

function publicFailure(message: unknown, code = 'GENERATION_FAILED') {
  const upstream = typeof message === 'string' ? message : '';
  let safe = 'MiniMax could not make the recording. Please try again.';
  if (/token|auth|unauthori[sz]ed|forbidden/i.test(upstream))
    safe = 'MiniMax rejected the API token. Check it and try again.';
  else if (/rate|quota|limit|too many/i.test(upstream))
    safe = 'MiniMax is handling too many requests. Please try again shortly.';
  else if (code === 'GENERATION_TIMEOUT')
    safe = 'The recording took too long to finish. Try the mehfil again.';
  else if (code === 'MISSING_AUDIO')
    safe = 'MiniMax succeeded but did not return an audio file.';
  else if (code === 'MINIMAX_UNAVAILABLE')
    safe = 'Generation failed while contacting MiniMax.';
  return { code, message: safe };
}

const MINIMAX_TOKEN_FORMAT_ERROR = 'MiniMax tokens start with sk-.';
const validMiniMaxToken = (token: string) => token.startsWith('sk-');

function staticFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  publicDir: string,
  shareBaseUrl = '',
) {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(publicDir, `.${requestPath}`);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error: NodeJS.ErrnoException | null, data: Buffer) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
      return;
    }
    const roomSources = shareBaseUrl
      ? `${shareBaseUrl} ${shareBaseUrl.replace(/^https:/, 'wss:')}`
      : '';
    res.writeHead(200, {
      'Content-Type':
        MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'self'; connect-src 'self' https://*.minimax.io${roomSources ? ` ${roomSources}` : ''}; media-src 'self' https: blob:; img-src 'self' data: https:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'`,
    });
    res.end(data);
  });
}

// pi-ai is ESM-only and this server is CommonJS, so the lyricist loads on first use.
// It also keeps startup fast and lets the music path work even if the lyricist fails.
let lyricistPromise: Promise<typeof import('./lyricist.ts')> | undefined;
function loadLyricist() {
  lyricistPromise = lyricistPromise || import('./lyricist.ts');
  return lyricistPromise;
}

export function createServer(options: ServerOptions = {}): http.Server {
  const apiBase =
    options.apiBase || process.env.MINIMAX_API_BASE || 'https://api.minimax.io';
  const fetchImpl: ServerFetch =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const writeLyricsImpl = options.writeLyrics;
  const shareBaseUrl = normalizeShareBaseUrl(
    options.shareBaseUrl ?? process.env.MEHFIL_SHARE_URL ?? '',
  );
  const vercelProductionHostname =
    options.vercelProjectProductionUrl ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const vercelProductionUrl = vercelProductionHostname
    ? `https://${vercelProductionHostname}`
    : '';
  const publicBaseUrl = normalizeShareBaseUrl(
    options.publicBaseUrl ??
      process.env.MEHFIL_PUBLIC_URL ??
      vercelProductionUrl,
  );
  const shareSecret = String(
    options.shareSecret ?? process.env.MEHFIL_SHARE_SECRET ?? '',
  ).trim();
  const sharingConfigured = Boolean(shareBaseUrl && shareSecret);
  const generationTimeoutMs =
    options.generationTimeoutMs ?? GENERATION_TIMEOUT_MS;
  const analysisTimeoutMs = options.analysisTimeoutMs ?? ANALYSIS_TIMEOUT_MS;
  const staticRoot = options.staticRoot ?? DEFAULT_STATIC_ROOT;
  const allowLocalHttpAudioSource = options.allowLocalHttpAudioSource === true;
  const sharedUrls = new Map<string, string>();

  async function recoveryRequest(
    pathname: string,
    { method = 'GET', body }: { method?: string; body?: unknown } = {},
  ): Promise<{ response: Response; value: JsonRecord }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RECOVERY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${shareBaseUrl}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${shareSecret}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      throw Object.assign(
        new Error(
          'Recording recovery is temporarily unavailable. Please check again.',
        ),
        { status: 503 },
      );
    } finally {
      clearTimeout(timeout);
    }
    let value: unknown;
    try {
      value = JSON.parse(await response.text()) as unknown;
    } catch {
      throw Object.assign(
        new Error(
          'Recording recovery returned an unreadable response. Please check again.',
        ),
        { status: 503 },
      );
    }
    if (!isRecord(value))
      throw Object.assign(
        new Error(
          'Recording recovery returned an unreadable response. Please check again.',
        ),
        { status: 503 },
      );
    return { response, value };
  }

  async function checkpoint(
    jobId: string,
    body: unknown,
  ): Promise<JsonRecord | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const checkpoint = await recoveryRequest(`/generation-jobs/${jobId}`, {
          method: 'PUT',
          body,
        });
        if (checkpoint.response.ok) return checkpoint.value;
      } catch {
        // A second bounded checkpoint attempt follows.
      }
    }
    return null;
  }

  const checkpointFailure = (jobId: string, failure: unknown) =>
    checkpoint(jobId, { status: 'failed', error: failure }).then(Boolean);
  const checkpointComplete = (jobId: string, completion: unknown) =>
    checkpoint(jobId, completion);
  const roomTimeoutMs = options.roomTimeoutMs || 2 * 60 * 1000;
  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
    if (req.method === 'POST' && req.url === '/api/write-lyrics') {
      try {
        const body = await readJson(req);
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        const idea = typeof body.idea === 'string' ? body.idea.trim() : '';
        const vibe = typeof body.vibe === 'string' ? body.vibe.trim() : '';
        const language =
          typeof body.language === 'string' ? body.language.trim() : 'auto';

        if (!token)
          return sendJson(res, 400, { error: 'Add your MiniMax API token.' });
        if (!validMiniMaxToken(token))
          return sendJson(res, 400, { error: MINIMAX_TOKEN_FORMAT_ERROR });
        if (!idea)
          return sendJson(res, 400, {
            error: 'Tell me what the song is about.',
          });
        if (idea.length > 400)
          return sendJson(res, 400, {
            error: 'Keep the idea under 400 characters.',
          });
        if (vibe.length > 400)
          return sendJson(res, 400, {
            error: 'Keep the vibe under 400 characters.',
          });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2 * 60 * 1000);
        try {
          const writeLyrics =
            writeLyricsImpl || (await loadLyricist()).writeLyrics;
          const result = await writeLyrics({
            token,
            idea,
            vibe,
            language,
            signal: controller.signal,
          });
          return sendJson(res, 200, result);
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        const details = errorDetails(error);
        if (details.name === 'AbortError')
          return sendJson(res, 504, {
            error: 'The lyricist took too long. Try again.',
          });
        return sendJson(res, details.status || 502, {
          error:
            details.status === 401
              ? 'MiniMax rejected the API token. Check it and try again.'
              : details.message || 'Could not write lyrics.',
        });
      }
    }

    if (req.method === 'POST' && req.url === '/api/analyze-timing') {
      try {
        const body = await readJson(req);
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        const source =
          typeof body.source === 'string' ? body.source.trim() : '';
        let outcome: TimingAnalysisOutcome;
        if (!validMiniMaxToken(token)) {
          outcome = {
            status: 'unavailable',
            reason: 'authentication',
            retryable: false,
          };
        } else {
          outcome = await analyzeMiniMaxTiming(
            { source, token },
            {
              apiBase,
              fetchImpl,
              timeoutMs: analysisTimeoutMs,
              allowLocalHttpSource: allowLocalHttpAudioSource,
            },
          );
        }
        return sendJson(res, validMiniMaxToken(token) ? 200 : 400, outcome);
      } catch {
        const outcome: TimingAnalysisOutcome = {
          status: 'unavailable',
          reason: 'malformed-response',
          retryable: false,
        };
        return sendJson(res, 400, outcome);
      }
    }

    if (req.method === 'POST' && req.url === '/api/generate') {
      let claimedJobId = '';
      let paidCallStarted = false;
      let audioReady = false;
      try {
        const body = await readJson(req);
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        const lyrics =
          typeof body.lyrics === 'string' ? body.lyrics.trim() : '';
        const prompt =
          typeof body.prompt === 'string' ? body.prompt.trim() : '';
        const jobId = typeof body.jobId === 'string' ? body.jobId : '';

        if (!token)
          return sendJson(res, 400, { error: 'Add your MiniMax API token.' });
        if (!validMiniMaxToken(token))
          return sendJson(res, 400, { error: MINIMAX_TOKEN_FORMAT_ERROR });
        if (!lyrics)
          return sendJson(res, 400, { error: 'Add some lyrics first.' });
        if (lyrics.length > 3500)
          return sendJson(res, 400, {
            error: 'Lyrics must be 3,500 characters or fewer.',
          });
        if (prompt.length > 2000)
          return sendJson(res, 400, {
            error: 'Sound description must be 2,000 characters or fewer.',
          });
        if (sharingConfigured && !JOB_ID_PATTERN.test(jobId))
          return sendJson(res, 400, {
            error: 'A valid generation job ID is required.',
          });

        if (sharingConfigured) {
          const claim = await recoveryRequest(
            `/generation-jobs/${jobId}/claim`,
            { method: 'POST' },
          );
          if (!claim.response.ok)
            return sendJson(res, 503, {
              error:
                claim.value.error ||
                'Recording recovery is temporarily unavailable. Please check again.',
            });
          if (claim.response.status === 200) {
            if (claim.value.status === 'complete')
              return sendJson(res, 200, completedGeneration(claim.value));
            const claimError = isRecord(claim.value.error)
              ? claim.value.error
              : {};
            if (claim.value.status === 'failed')
              return sendJson(res, 400, {
                error: claimError.message || 'Generation failed.',
              });
            return sendJson(res, 202, { jobId, status: 'pending' });
          }
          claimedJobId = jobId;
        }

        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          generationTimeoutMs,
        );
        let upstream;
        try {
          paidCallStarted = true;
          upstream = await fetchImpl(`${apiBase}/v1/music_generation`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'music-3.0',
              prompt:
                prompt ||
                'Warm contemporary Indian pop with natural native pronunciation, expressive vocals, organic instrumentation, and a memorable melodic chorus.',
              lyrics,
              audio_setting: {
                sample_rate: 44100,
                bitrate: 256000,
                format: 'mp3',
              },
              output_format: 'url',
              stream: false,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        const text = await upstream.text();
        const result = parseJsonRecord(text) ?? {
          error: text || 'MiniMax returned an unreadable response.',
        };
        // Timing is server-issued only; never let an upstream field masquerade.
        delete result.lyric_timing;
        const baseResponse = isRecord(result.base_resp) ? result.base_resp : {};
        const resultError = isRecord(result.error) ? result.error : {};

        if (!upstream.ok || baseResponse.status_code) {
          const message =
            baseResponse.status_msg ||
            resultError.message ||
            (typeof result.error === 'string' ? result.error : '') ||
            `MiniMax request failed (${upstream.status})`;
          const failure = publicFailure(message, 'MINIMAX_FAILED');
          if (claimedJobId && !(await checkpointFailure(claimedJobId, failure)))
            return sendJson(res, 503, {
              error:
                'Generation ended, but recovery could not save its final status. Please check again.',
            });
          return sendJson(res, upstream.ok ? 400 : upstream.status, {
            error: failure.message,
          });
        }
        const source = audioSource(result, allowLocalHttpAudioSource);
        if (!source) {
          const failure = publicFailure(
            'MiniMax succeeded but did not return an audio file.',
            'MISSING_AUDIO',
          );
          if (claimedJobId && !(await checkpointFailure(claimedJobId, failure)))
            return sendJson(res, 503, {
              error:
                'Generation ended, but recovery could not save its final status. Please check again.',
            });
          return sendJson(res, 502, { error: failure.message });
        }
        audioReady = true;
        if (claimedJobId) {
          const resultData = isRecord(result.data) ? result.data : {};
          const traceId =
            result.trace_id || result.traceId || resultData.trace_id;
          const checkpoint = await checkpointComplete(claimedJobId, {
            status: 'complete',
            source,
            ...(typeof traceId === 'string' ? { traceId } : {}),
          });
          if (!checkpoint)
            return sendJson(res, 503, {
              error:
                'Your recording finished, but its recovery checkpoint could not be saved. Start a new song when you are ready.',
            });
          return sendJson(res, 200, completedGeneration(checkpoint));
        }
        return sendJson(res, 200, result);
      } catch (error) {
        const details = errorDetails(error);
        if (details.name === 'AbortError') {
          const failure = publicFailure(
            'Generation timed out.',
            'GENERATION_TIMEOUT',
          );
          if (claimedJobId && !(await checkpointFailure(claimedJobId, failure)))
            return sendJson(res, 503, {
              error:
                'Generation ended, but recovery could not save its final status. Please check again.',
            });
          return sendJson(res, 504, { error: failure.message });
        }
        if (claimedJobId && paidCallStarted && !audioReady) {
          const failure = publicFailure(
            'Generation failed while contacting MiniMax.',
            'MINIMAX_UNAVAILABLE',
          );
          if (!(await checkpointFailure(claimedJobId, failure)))
            return sendJson(res, 503, {
              error:
                'Generation ended, but recovery could not save its final status. Please check again.',
            });
          return sendJson(res, 502, { error: failure.message });
        }
        return sendJson(res, details.status || 500, {
          error: details.message || 'Generation failed.',
        });
      }
    }

    if (
      req.method === 'GET' &&
      new URL(req.url ?? '/', 'http://localhost').pathname ===
        '/api/generation-status'
    ) {
      const jobId =
        new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ||
        '';
      if (!JOB_ID_PATTERN.test(jobId))
        return sendJson(res, 400, {
          error: 'A valid generation job ID is required.',
        });
      if (!sharingConfigured)
        return sendJson(res, 503, {
          error:
            'This deployment cannot recover a recording after the page loses its response.',
        });
      try {
        const status = await recoveryRequest(`/generation-jobs/${jobId}`);
        if (status.response.status === 404)
          return sendJson(res, 404, {
            error: 'That recording can no longer be recovered.',
          });
        if (!status.response.ok)
          return sendJson(res, 503, {
            error:
              'Recording recovery is temporarily unavailable. Please check again.',
          });
        if (status.value.status === 'complete')
          return sendJson(res, 200, completedGeneration(status.value));
        const statusError = isRecord(status.value.error)
          ? status.value.error
          : {};
        if (status.value.status === 'failed')
          return sendJson(res, 200, {
            jobId,
            status: 'failed',
            error: statusError.message || 'Generation failed.',
          });
        return sendJson(res, 200, { jobId, status: 'pending' });
      } catch (error) {
        const details = errorDetails(error);
        return sendJson(res, details.status || 503, {
          error:
            details.message ||
            'Recording recovery is temporarily unavailable. Please check again.',
        });
      }
    }

    if (req.method === 'POST' && req.url === '/api/share') {
      try {
        if (!sharingConfigured)
          return sendJson(res, 503, {
            error: 'Sharing is not configured on this mehfil.',
          });
        const body = await readJson(req);
        const shareReference =
          typeof body.shareRef === 'string' ? body.shareRef : '';
        if (!JOB_ID_PATTERN.test(shareReference))
          return sendJson(res, 404, {
            error:
              'That recording is no longer ready to share. Make it again and retry.',
          });
        if (sharedUrls.has(shareReference))
          return sendJson(res, 201, { url: sharedUrls.get(shareReference) });
        const recovered = await recoveryRequest(
          `/generation-jobs/${shareReference}`,
        );
        if (!recovered.response.ok || recovered.value.status !== 'complete')
          return sendJson(res, 404, {
            error:
              'That recording is no longer ready to share. Make it again and retry.',
          });
        const entry = {
          source:
            typeof recovered.value.source === 'string'
              ? recovered.value.source
              : '',
        };
        const lyricTiming = normalizeLyricTiming(body.lyricTiming);
        if (body.lyricTiming != null && !lyricTiming)
          return sendJson(res, 400, {
            error: 'The section timing artifact is invalid.',
          });

        const metadata = {
          title: typeof body.title === 'string' ? body.title : '',
          language: typeof body.language === 'string' ? body.language : '',
          nativeScriptName:
            typeof body.nativeScriptName === 'string'
              ? body.nativeScriptName
              : '',
          isLatinScript: Boolean(body.isLatinScript),
          lyricsNative:
            typeof body.lyricsNative === 'string' ? body.lyricsNative : '',
          lyricsRoman:
            typeof body.lyricsRoman === 'string' ? body.lyricsRoman : '',
          // The opaque share reference still proves this is a server-issued
          // recording. The browser supplies only the normalized artifact from
          // the separate, request-only timing analysis.
          lyricTiming,
        };

        let audio = decodeAudioSource(entry.source, allowLocalHttpAudioSource);
        if (!audio) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2 * 60 * 1000);
          try {
            const response = await fetchImpl(entry.source, {
              signal: controller.signal,
            });
            if (!response.ok)
              throw Object.assign(
                new Error(
                  'The finished recording could not be downloaded. Please retry.',
                ),
                { status: 502 },
              );
            audio = await readLimitedBody(response, MAX_SHARE_AUDIO_BYTES);
          } finally {
            clearTimeout(timeout);
          }
        }
        if (!audio.length)
          throw Object.assign(new Error('The finished recording is empty.'), {
            status: 502,
          });

        const form = new FormData();
        form.set(
          'audio',
          new Blob([Uint8Array.from(audio)], { type: 'audio/mpeg' }),
          'mehfil-song.mp3',
        );
        form.set('metadata', JSON.stringify(metadata));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2 * 60 * 1000);
        let response;
        try {
          response = await fetchImpl(`${shareBaseUrl}/shares`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${shareSecret}`,
              'Idempotency-Key': shareReference,
            },
            body: form,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        const text = await response.text();
        const result = parseJsonRecord(text) ?? {
          error: 'The share service returned an unreadable response.',
        };
        if (!response.ok)
          return sendJson(res, response.status, {
            error: result.error || 'The song could not be shared.',
          });
        let publicUrl;
        try {
          if (typeof result.url !== 'string') throw new Error('Invalid link');
          publicUrl = new URL(result.url);
        } catch {
          throw Object.assign(
            new Error('The share service returned an invalid link.'),
            { status: 502 },
          );
        }
        const configuredOrigin = new URL(shareBaseUrl).origin;
        if (
          publicUrl.origin !== configuredOrigin ||
          !/^\/s\/[A-Za-z0-9_-]{16}$/.test(publicUrl.pathname)
        ) {
          throw Object.assign(
            new Error('The share service returned an invalid link.'),
            { status: 502 },
          );
        }
        const cleanUrl = `${publicBaseUrl || publicUrl.origin}${publicUrl.pathname}`;
        sharedUrls.set(shareReference, cleanUrl);
        return sendJson(res, 201, { url: cleanUrl });
      } catch (error) {
        const details = errorDetails(error);
        if (details.name === 'AbortError')
          return sendJson(res, 504, {
            error: 'Sharing took too long. Please retry.',
          });
        return sendJson(res, details.status || 502, {
          error:
            details.message || 'The song could not be shared. Please retry.',
        });
      }
    }

    if (req.method === 'POST' && req.url === '/api/rooms') {
      try {
        if (!sharingConfigured)
          return sendJson(res, 503, {
            error: 'Live rooms are not configured on this mehfil.',
          });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), roomTimeoutMs);
        let response;
        try {
          response = await fetchImpl(`${shareBaseUrl}/rooms`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${shareSecret}`,
              'Content-Type': 'application/json',
            },
            body: '{}',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        const text = await response.text();
        const result = parseJsonRecord(text) ?? {
          error: 'The room service returned an unreadable response.',
        };
        if (!response.ok)
          return sendJson(res, response.status, {
            error: result.error || 'The room could not be opened.',
          });
        const roomId = typeof result.roomId === 'string' ? result.roomId : '';
        if (!isRoomId(roomId))
          throw Object.assign(
            new Error('The room service returned invalid room details.'),
            { status: 502 },
          );
        let joinUrl: URL;
        let socketUrl: URL;
        try {
          if (
            typeof result.joinUrl !== 'string' ||
            typeof result.socketUrl !== 'string'
          )
            throw new Error('Invalid room URLs');
          joinUrl = new URL(result.joinUrl);
          socketUrl = new URL(result.socketUrl);
        } catch {
          throw Object.assign(
            new Error('The room service returned invalid room details.'),
            { status: 502 },
          );
        }
        const configured = new URL(shareBaseUrl);
        const validJoin =
          joinUrl.protocol === 'https:' &&
          joinUrl.origin === configured.origin &&
          joinUrl.pathname === `/r/${roomId}` &&
          !joinUrl.search &&
          !joinUrl.hash &&
          !joinUrl.username &&
          !joinUrl.password;
        const validSocket =
          socketUrl.protocol === 'wss:' &&
          socketUrl.host === configured.host &&
          socketUrl.pathname === `/rooms/${roomId}/ws` &&
          !socketUrl.search &&
          !socketUrl.hash &&
          !socketUrl.username &&
          !socketUrl.password;
        const validSecret =
          typeof result.hostSecret === 'string' &&
          /^[A-Za-z0-9_-]{43}$/.test(result.hostSecret);
        const expiresAt = Number(result.expiresAt);
        if (
          !validJoin ||
          !validSocket ||
          !validSecret ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= Date.now()
        )
          throw Object.assign(
            new Error('The room service returned invalid room details.'),
            { status: 502 },
          );
        return sendJson(res, 201, {
          roomId,
          joinUrl: joinUrl.href,
          socketUrl: socketUrl.href,
          hostSecret: result.hostSecret,
          expiresAt,
        });
      } catch (error) {
        const details = errorDetails(error);
        if (details.name === 'AbortError')
          return sendJson(res, 504, {
            error: 'Opening the room took too long. Please retry.',
          });
        return sendJson(res, details.status || 502, {
          error: details.message || 'The room could not be opened.',
        });
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD')
      return staticFile(req, res, staticRoot, shareBaseUrl);
    res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end('Method not allowed');
  };
  return http.createServer((request, response) => {
    void handleRequest(request, response);
  });
}

export function assertHostBuild(staticRoot = DEFAULT_STATIC_ROOT): void {
  if (!fs.existsSync(path.join(staticRoot, 'index.html'))) {
    throw new Error(
      'Host build is missing. Run `pnpm run build:host` before `pnpm start`.',
    );
  }
}

export function resolveDirectEntryPort(
  args: readonly string[],
  environmentPort?: string,
): number {
  const positions = args.flatMap((argument, index) =>
    argument === '--port' ? [index] : [],
  );
  if (positions.length > 1) {
    throw new Error('The --port option may only be provided once.');
  }
  const position = positions[0];
  if (position !== undefined) {
    const value = args[position + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('--port requires an integer TCP port from 1 to 65535.');
    }
    return parseTcpPort(value, '--port');
  }
  return environmentPort === undefined || environmentPort === ''
    ? 4173
    : parseTcpPort(environmentPort, 'PORT');
}

const server = createServer();

if (isDirectEntry(import.meta.url)) {
  const port = resolveDirectEntryPort(process.argv.slice(2), process.env.PORT);
  if (!process.argv.includes('--api-only')) assertHostBuild();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Mehfil is open at http://127.0.0.1:${port}`);
  });
}

export default server;
