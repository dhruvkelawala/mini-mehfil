import { base64Url, randomBase64Url } from '../room/primitives.ts';
import { isRecord } from '../room/protocol.ts';
import { constantTimeEqual, sha256 } from '../room/transport.ts';
import { playbackPage } from './playback-page.ts';
import type { PlaybackSong } from './playback-page.ts';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 128 * 1024;
const ALLOWED_AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp3']);
const ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const JOB_VERSION = 1;
const MAX_JOB_JSON_BYTES = 64 * 1024;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_JOB_TTL_MS = 5 * 60 * 1000;
const REPOSITORY_URL = 'https://github.com/dhruvkelawala/mini-mehfil';

interface SongMetadata extends PlaybackSong {
  createdAt: string;
}

interface GenerationJob {
  version: 1;
  jobId: string;
  status: 'pending' | 'complete' | 'failed';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  source?: string;
  traceId?: string;
  error?: { code: string; message: string };
}

interface JobResult {
  created?: boolean;
  conflict?: boolean;
  record?: unknown;
  etag?: string;
}

interface SharedAudio {
  audio: ArrayBuffer;
  contentType: string;
  metadata: SongMetadata;
}

type AudioResult = R2ObjectBody | { unsatisfiable: true; size: number };

export interface ShareStorage {
  put(id: string, share: SharedAudio): Promise<void>;
  getMetadata(id: string): Promise<SongMetadata | null>;
  getAudio(id: string, range: string | null): Promise<AudioResult | null>;
  claimJob(id: string, record: GenerationJob): Promise<JobResult>;
  getJob(id: string): Promise<JobResult | null>;
  transitionJob(
    id: string,
    record: GenerationJob,
    etag: string | undefined,
  ): Promise<JobResult>;
}

interface ShareHandlerOptions {
  storage: ShareStorage;
  rateLimit?: (caller: string) => Promise<boolean>;
  idGenerator?: (idempotencyKey: string, secret: string) => Promise<string>;
  uploadSecret?: string;
  publicBaseUrl?: string;
  previewImageUrl?: string;
  now?: () => number;
}

function errorDetails(error: unknown): { message: string; status?: number } {
  if (!(error instanceof Error)) return { message: String(error) };
  const status =
    isRecord(error) && typeof error.status === 'number'
      ? error.status
      : undefined;
  return {
    message: error.message,
    ...(status === undefined ? {} : { status }),
  };
}

function json(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function randomId(): string {
  return randomBase64Url(12);
}

async function validBearer(request: Request, secret: string): Promise<boolean> {
  const authorization = request.headers.get('authorization') || '';
  const provided = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';
  const [expectedDigest, providedDigest] = await Promise.all([
    sha256(secret),
    sha256(provided),
  ]);
  return Boolean(provided) && constantTimeEqual(providedDigest, expectedDigest);
}

async function deriveShareId(
  idempotencyKey: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(idempotencyKey),
    ),
  );
  return base64Url(signature.slice(0, 12));
}

async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Object.assign(new Error('Audio must be 10 MB or smaller.'), {
        status: 413,
      });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function validateMetadata(raw: FormDataEntryValue | null): SongMetadata {
  if (typeof raw !== 'string' || raw.length > 16 * 1024) {
    throw new Error('Invalid song details.');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid song details.');
  }
  if (!isRecord(value)) throw new Error('Invalid song details.');

  const text = (key: string, max: number, required = false): string => {
    const candidate = value[key];
    const entry = typeof candidate === 'string' ? candidate.trim() : '';
    if ((required && !entry) || entry.length > max)
      throw new Error('Invalid song details.');
    return entry;
  };

  const metadata = {
    title: text('title', 120, true),
    language: text('language', 80, true),
    nativeScriptName: text('nativeScriptName', 80),
    isLatinScript: Boolean(value.isLatinScript),
    lyricsNative: text('lyricsNative', 5000, true),
    lyricsRoman: text('lyricsRoman', 5000, true),
    createdAt: new Date().toISOString(),
  };
  return metadata;
}

function pendingJob(jobId: string, now: number): GenerationJob {
  const createdAt = new Date(now).toISOString();
  return {
    version: JOB_VERSION,
    jobId,
    status: 'pending' as const,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(now + JOB_TTL_MS).toISOString(),
  };
}

function validAudioSource(source: unknown): source is string {
  if (typeof source !== 'string' || !source || source.length > 32 * 1024)
    return false;
  if (/^(?:0x)?[0-9a-f]+$/i.test(source))
    return source.replace(/^0x/i, '').length % 2 === 0;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validStoredJob(value: unknown, jobId: string): GenerationJob | null {
  if (
    !isRecord(value) ||
    value.version !== JOB_VERSION ||
    value.jobId !== jobId ||
    (value.status !== 'pending' &&
      value.status !== 'complete' &&
      value.status !== 'failed')
  )
    return null;
  const parseIsoDate = (entry: unknown) =>
    typeof entry === 'string' && Number.isFinite(Date.parse(entry))
      ? entry
      : null;
  const createdAt = parseIsoDate(value.createdAt);
  const updatedAt = parseIsoDate(value.updatedAt);
  const expiresAt = parseIsoDate(value.expiresAt);
  if (!createdAt || !updatedAt || !expiresAt) return null;
  const record: GenerationJob = {
    version: JOB_VERSION,
    jobId,
    status: value.status,
    createdAt,
    updatedAt,
    expiresAt,
  };
  if (value.status === 'complete') {
    if (!validAudioSource(value.source)) return null;
    record.source = value.source;
    if (
      typeof value.traceId === 'string' &&
      /^[A-Za-z0-9._:-]{1,200}$/.test(value.traceId)
    )
      record.traceId = value.traceId;
  }
  if (value.status === 'failed') {
    const error = isRecord(value.error) ? value.error : null;
    if (
      !error ||
      typeof error.code !== 'string' ||
      typeof error.message !== 'string'
    )
      return null;
    if (
      !error.code ||
      error.code.length > 80 ||
      !error.message ||
      error.message.length > 500
    )
      return null;
    record.error = { code: error.code, message: error.message };
  }
  return record;
}

function terminalJob(
  current: GenerationJob,
  input: unknown,
  now: number,
): GenerationJob {
  if (!isRecord(input)) {
    throw Object.assign(
      new Error('Only complete or failed transitions are allowed.'),
      { status: 400 },
    );
  }
  const base: GenerationJob = {
    version: JOB_VERSION,
    jobId: current.jobId,
    status: input.status === 'complete' ? 'complete' : 'failed',
    createdAt: current.createdAt,
    updatedAt: new Date(now).toISOString(),
    expiresAt: current.expiresAt,
  };
  if (input.status === 'complete') {
    if (!validAudioSource(input.source))
      throw Object.assign(new Error('A valid audio source is required.'), {
        status: 400,
      });
    base.source = input.source;
    if (typeof input.traceId === 'string') {
      const traceId = input.traceId.trim();
      if (/^[A-Za-z0-9._:-]{1,200}$/.test(traceId)) base.traceId = traceId;
    }
    return base;
  }
  if (input.status === 'failed') {
    const error = isRecord(input.error) ? input.error : {};
    const code =
      typeof error.code === 'string' ? error.code.trim().slice(0, 80) : '';
    const message =
      typeof error.message === 'string'
        ? error.message.trim().slice(0, 500)
        : '';
    if (!code || !message)
      throw Object.assign(new Error('A stable public error is required.'), {
        status: 400,
      });
    base.error = { code, message };
    return base;
  }
  throw Object.assign(
    new Error('Only complete or failed transitions are allowed.'),
    { status: 400 },
  );
}

function sameTerminal(left: GenerationJob, right: GenerationJob): boolean {
  return (
    left.status === right.status &&
    left.source === right.source &&
    left.traceId === right.traceId &&
    left.error?.code === right.error?.code &&
    left.error?.message === right.error?.message
  );
}

async function settleAbandonedJob(
  storage: ShareStorage,
  result: JobResult | null,
  jobId: string,
  currentTime: number,
): Promise<JobResult | null> {
  const current = validStoredJob(result?.record, jobId);
  const stillRecoverable =
    current && Date.parse(current.expiresAt) > currentTime;
  const abandoned =
    stillRecoverable &&
    current.status === 'pending' &&
    Date.parse(current.updatedAt) + PENDING_JOB_TTL_MS <= currentTime;
  if (!abandoned) return result;

  const failed = terminalJob(
    current,
    {
      status: 'failed',
      error: {
        code: 'GENERATION_INTERRUPTED',
        message:
          'The recording stopped before it could finish. Try the mehfil again.',
      },
    },
    currentTime,
  );
  const transitioned = await storage.transitionJob(jobId, failed, result?.etag);
  if (!transitioned.conflict) return transitioned;
  return await storage.getJob(jobId);
}

async function readJobJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JOB_JSON_BYTES)
    throw Object.assign(new Error('Job update is too large.'), { status: 413 });
  const bytes = await readBody(request, MAX_JOB_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

function parseByteRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(requestedEnd) ||
    offset >= size ||
    requestedEnd < offset
  )
    return null;
  return { offset, length: Math.min(requestedEnd, size - 1) - offset + 1 };
}

function notFoundPage(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>This song has left the mehfil</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 20%,#315d55,#112f2d 55%,#081b1c);color:#f9edda;font:18px Georgia,serif;text-align:center}.card{max-width:34rem;padding:3rem}.moon{font-size:4rem;color:#e6a653}h1{font-size:clamp(2rem,8vw,4rem);margin:.5rem}p{line-height:1.6;color:#d9c9ae}a{color:#e6a653}</style><main class="card"><div class="moon">☾</div><h1>This song has left the mehfil.</h1><p>It may have finished its stay in the courtyard, but there is always room to make another.</p><a href="${REPOSITORY_URL}">Make your own song →</a></main></html>`;
}

export function createR2Storage(bucket: R2Bucket): ShareStorage {
  const conditionalEtag = (
    object: R2Object | R2ObjectBody | null,
  ): string | undefined =>
    object?.etag || object?.httpEtag?.replace(/^"|"$/g, '');
  return {
    async put(id: string, share: SharedAudio) {
      await bucket.put(`shares/${id}.mp3`, share.audio, {
        httpMetadata: {
          contentType: share.contentType,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
      try {
        await bucket.put(`shares/${id}.json`, JSON.stringify(share.metadata), {
          httpMetadata: {
            contentType: 'application/json; charset=utf-8',
            cacheControl: 'public, max-age=300',
          },
        });
      } catch (error) {
        await bucket.delete(`shares/${id}.mp3`);
        throw error;
      }
    },
    async getMetadata(id: string) {
      const object = await bucket.get(`shares/${id}.json`);
      if (!object) return null;
      try {
        const value: unknown = JSON.parse(await object.text());
        if (!isRecord(value)) return null;
        const fields = [
          'title',
          'language',
          'nativeScriptName',
          'lyricsNative',
          'lyricsRoman',
          'createdAt',
        ];
        if (!fields.every((field) => typeof value[field] === 'string'))
          return null;
        return {
          title: String(value.title),
          language: String(value.language),
          nativeScriptName: String(value.nativeScriptName),
          isLatinScript: Boolean(value.isLatinScript),
          lyricsNative: String(value.lyricsNative),
          lyricsRoman: String(value.lyricsRoman),
          createdAt: String(value.createdAt),
        };
      } catch {
        return null;
      }
    },
    async getAudio(id: string, range: string | null) {
      const key = `shares/${id}.mp3`;
      if (!range) return bucket.get(key);
      const object = await bucket.head(key);
      if (!object) return null;
      const parsedRange = parseByteRange(range, object.size);
      if (!parsedRange) return { unsatisfiable: true, size: object.size };
      return bucket.get(key, { range: parsedRange });
    },
    async claimJob(id: string, record: GenerationJob) {
      const object = await bucket.put(
        `jobs/${id}.json`,
        JSON.stringify(record),
        {
          onlyIf: { etagDoesNotMatch: '*' },
          httpMetadata: {
            contentType: 'application/json; charset=utf-8',
            cacheControl: 'no-store',
          },
        },
      );
      if (!object) return { created: false };
      const etag = conditionalEtag(object);
      return { created: true, record, ...(etag ? { etag } : {}) };
    },
    async getJob(id: string) {
      const object = await bucket.get(`jobs/${id}.json`);
      if (!object) return null;
      try {
        const etag = conditionalEtag(object);
        return {
          record: JSON.parse(await object.text()),
          ...(etag ? { etag } : {}),
        };
      } catch {
        return null;
      }
    },
    async transitionJob(
      id: string,
      record: GenerationJob,
      etag: string | undefined,
    ) {
      if (!etag) return { conflict: true };
      const object = await bucket.put(
        `jobs/${id}.json`,
        JSON.stringify(record),
        {
          onlyIf: { etagMatches: etag },
          httpMetadata: {
            contentType: 'application/json; charset=utf-8',
            cacheControl: 'no-store',
          },
        },
      );
      if (!object) return { conflict: true };
      const nextEtag = conditionalEtag(object);
      return {
        conflict: false,
        record,
        ...(nextEtag ? { etag: nextEtag } : {}),
      };
    },
  };
}

export function createShareHandler({
  storage,
  rateLimit = () => Promise.resolve(true),
  idGenerator = deriveShareId,
  uploadSecret = '',
  publicBaseUrl = '',
  previewImageUrl = '',
  now = Date.now,
}: ShareHandlerOptions) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const claimMatch = url.pathname.match(
      /^\/generation-jobs\/([^/]+)\/claim$/,
    );
    const jobMatch = url.pathname.match(/^\/generation-jobs\/([^/]+)$/);
    if (
      (claimMatch && request.method === 'POST') ||
      (jobMatch && ['GET', 'PUT'].includes(request.method))
    ) {
      if (!uploadSecret)
        return json({ error: 'Generation recovery is not configured.' }, 503);
      if (!(await validBearer(request, uploadSecret)))
        return json({ error: 'Job credentials are missing or invalid.' }, 401, {
          'www-authenticate': 'Bearer',
        });
      const jobId = (claimMatch ?? jobMatch)?.[1];
      if (!jobId)
        return json({ error: 'A valid generation job ID is required.' }, 400);
      if (!JOB_ID_PATTERN.test(jobId))
        return json({ error: 'A valid generation job ID is required.' }, 400);

      try {
        if (claimMatch) {
          const currentTime = now();
          const record = pendingJob(jobId, currentTime);
          let result: JobResult | null = await storage.claimJob(jobId, record);
          if (!result.created && !result.record)
            result = { ...result, ...(await storage.getJob(jobId)) };
          if (!result.created)
            result = await settleAbandonedJob(
              storage,
              result,
              jobId,
              currentTime,
            );
          if (!result)
            return json({ error: 'Generation job is unavailable.' }, 404);
          const stored = validStoredJob(result.record, jobId);
          if (!stored || Date.parse(stored.expiresAt) <= currentTime)
            return json({ error: 'Generation job is unavailable.' }, 404);
          return json(stored, result.created ? 201 : 200);
        }

        const currentTime = now();
        let currentResult = await storage.getJob(jobId);
        currentResult = await settleAbandonedJob(
          storage,
          currentResult,
          jobId,
          currentTime,
        );
        if (!currentResult)
          return json({ error: 'Generation job was not found.' }, 404);
        const current = validStoredJob(currentResult.record, jobId);
        if (!current || Date.parse(current.expiresAt) <= currentTime)
          return json({ error: 'Generation job was not found.' }, 404);
        if (request.method === 'GET') return json(current);

        const input = await readJobJson(request);
        const next = terminalJob(current, input, currentTime);
        if (current.status !== 'pending')
          return sameTerminal(current, next)
            ? json(current)
            : json({ error: 'Generation job is already finished.' }, 409);
        const transitioned = await storage.transitionJob(
          jobId,
          next,
          currentResult.etag,
        );
        if (transitioned.conflict) {
          const winner = validStoredJob(
            (await storage.getJob(jobId))?.record,
            jobId,
          );
          if (winner && sameTerminal(winner, next)) return json(winner);
          return json({ error: 'Generation job changed concurrently.' }, 409);
        }
        return json(next);
      } catch (error) {
        const details = errorDetails(error);
        return json(
          { error: details.message || 'Generation job request failed.' },
          details.status ?? 503,
        );
      }
    }

    if (request.method === 'POST' && url.pathname === '/shares') {
      if (!uploadSecret)
        return json({ error: 'Sharing is not configured.' }, 503);
      if (!(await validBearer(request, uploadSecret))) {
        return json(
          { error: 'Upload credentials are missing or invalid.' },
          401,
          { 'www-authenticate': 'Bearer' },
        );
      }
      const idempotencyKey = request.headers.get('idempotency-key') || '';
      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))
        return json({ error: 'A valid idempotency key is required.' }, 400);
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      if (!(await rateLimit(ip)))
        return json(
          {
            error:
              'Too many songs are arriving at once. Please try again in a minute.',
          },
          429,
          { 'retry-after': '60' },
        );

      const declaredSize = Number(request.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > MAX_REQUEST_BYTES)
        return json({ error: 'Audio must be 10 MB or smaller.' }, 413);
      if (
        !request.headers
          .get('content-type')
          ?.toLowerCase()
          .startsWith('multipart/form-data;')
      )
        return json(
          { error: 'Send audio and song details as multipart form data.' },
          415,
        );

      let form;
      try {
        const body = await readBody(request, MAX_REQUEST_BYTES);
        form = await new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: exactArrayBuffer(body),
        }).formData();
      } catch (error) {
        const details = errorDetails(error);
        return json(
          {
            error:
              details.status === 413
                ? details.message
                : 'Could not read the upload.',
          },
          details.status ?? 400,
        );
      }
      const audio = form.get('audio');
      if (!audio || typeof audio === 'string')
        return json({ error: 'Add an MP3 recording.' }, 400);
      const contentType = String(audio.type || '').toLowerCase();
      if (!ALLOWED_AUDIO_TYPES.has(contentType))
        return json({ error: 'Only MP3 audio can be shared.' }, 415);
      if (!audio.size || audio.size > MAX_AUDIO_BYTES)
        return json({ error: 'Audio must be 10 MB or smaller.' }, 413);

      let metadata;
      try {
        metadata = validateMetadata(form.get('metadata'));
      } catch (error) {
        return json({ error: errorDetails(error).message }, 400);
      }
      const id = await idGenerator(idempotencyKey, uploadSecret);
      if (!ID_PATTERN.test(id))
        return json({ error: 'Could not create a share link.' }, 500);
      try {
        await storage.put(id, {
          audio: await audio.arrayBuffer(),
          contentType,
          metadata,
        });
      } catch {
        return json(
          { error: 'The song could not be stored. Please retry.' },
          503,
        );
      }
      return json({ id, url: `${url.origin}/s/${id}` }, 201);
    }

    const match = url.pathname.match(
      /^\/s\/([A-Za-z0-9_-]{16})(?:\/(audio))?$/,
    );
    if (match && (request.method === 'GET' || request.method === 'HEAD')) {
      const [, id, asset] = match;
      if (!id) return json({ error: 'Not found.' }, 404);
      if (asset === 'audio') {
        const object = await storage.getAudio(id, request.headers.get('range'));
        if (!object) return new Response(null, { status: 404 });
        if ('unsatisfiable' in object)
          return new Response(null, {
            status: 416,
            headers: {
              'accept-ranges': 'bytes',
              'content-range': `bytes */${object.size}`,
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            },
          });
        const headers = new Headers({
          'content-type': object.httpMetadata?.contentType || 'audio/mpeg',
          'cache-control': 'public, max-age=31536000, immutable',
          'accept-ranges': 'bytes',
          'x-content-type-options': 'nosniff',
        });
        if (object.httpEtag || object.etag)
          headers.set('etag', object.httpEtag || object.etag);
        if (
          object.range &&
          'offset' in object.range &&
          Number.isFinite(object.size)
        ) {
          const offset = object.range.offset;
          const length = object.range.length ?? object.size;
          headers.set('cache-control', 'no-store');
          headers.set(
            'content-range',
            `bytes ${offset}-${offset + length - 1}/${object.size}`,
          );
          headers.set('content-length', String(length));
          return new Response(request.method === 'HEAD' ? null : object.body, {
            status: 206,
            headers,
          });
        }
        if (Number.isFinite(object.size))
          headers.set('content-length', String(object.size));
        return new Response(request.method === 'HEAD' ? null : object.body, {
          headers,
        });
      }

      const song = await storage.getMetadata(id);
      if (!song)
        return new Response(request.method === 'HEAD' ? null : notFoundPage(), {
          status: 404,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      const nonce = randomId();
      const html = playbackPage(
        id,
        song,
        nonce,
        publicBaseUrl || url.origin,
        previewImageUrl,
      );
      return new Response(request.method === 'HEAD' ? null : html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
          'content-security-policy': `default-src 'none'; media-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors https://twitter.com https://*.twitter.com https://x.com https://*.x.com`,
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    return json({ error: 'Not found.' }, 404);
  };
}
