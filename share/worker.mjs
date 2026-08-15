import { playbackPage } from './playback-page.mjs';
import { roomPage } from './room-page.mjs';
import { createRoomTransport, sha256 } from './room-transport.mjs';

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
const ROOM_ID_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const REPOSITORY_URL = 'https://github.com/dhruvkelawala/mini-mehfil';

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    }
  });
}

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function validBearer(request, secret) {
  const authorization = request.headers.get('authorization') || '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const [expectedDigest, providedDigest] = await Promise.all([digest(secret), digest(provided)]);
  let difference = expectedDigest.length ^ providedDigest.length;
  for (let index = 0; index < expectedDigest.length; index += 1) difference |= expectedDigest[index] ^ providedDigest[index];
  return Boolean(provided) && difference === 0;
}

async function deriveShareId(idempotencyKey, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(idempotencyKey)));
  return base64Url(signature.slice(0, 12));
}

async function readBody(request, limit) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Object.assign(new Error('Audio must be 10 MB or smaller.'), { status: 413 });
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

function validateMetadata(raw) {
  if (typeof raw !== 'string' || raw.length > 16 * 1024) throw new Error('Invalid song details.');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Invalid song details.'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid song details.');

  const text = (key, max, required = false) => {
    const entry = typeof value[key] === 'string' ? value[key].trim() : '';
    if ((required && !entry) || entry.length > max) throw new Error('Invalid song details.');
    return entry;
  };

  const metadata = {
    title: text('title', 120, true),
    language: text('language', 80, true),
    nativeScriptName: text('nativeScriptName', 80),
    isLatinScript: Boolean(value.isLatinScript),
    lyricsNative: text('lyricsNative', 5000, true),
    lyricsRoman: text('lyricsRoman', 5000, true),
    createdAt: new Date().toISOString()
  };
  return metadata;
}

function pendingJob(jobId, now) {
  const createdAt = new Date(now).toISOString();
  return {
    version: JOB_VERSION,
    jobId,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(now + JOB_TTL_MS).toISOString()
  };
}

function validAudioSource(source) {
  if (typeof source !== 'string' || !source || source.length > 32 * 1024) return false;
  if (/^(?:0x)?[0-9a-f]+$/i.test(source)) return source.replace(/^0x/i, '').length % 2 === 0;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

function validStoredJob(value, jobId) {
  if (!value || value.version !== JOB_VERSION || value.jobId !== jobId || !['pending', 'complete', 'failed'].includes(value.status)) return null;
  if (![value.createdAt, value.updatedAt, value.expiresAt].every(entry => typeof entry === 'string' && Number.isFinite(Date.parse(entry)))) return null;
  const record = {
    version: JOB_VERSION,
    jobId,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt
  };
  if (value.status === 'complete') {
    if (!validAudioSource(value.source)) return null;
    record.source = value.source;
    if (typeof value.traceId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value.traceId)) record.traceId = value.traceId;
  }
  if (value.status === 'failed') {
    if (!value.error || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') return null;
    if (!value.error.code || value.error.code.length > 80 || !value.error.message || value.error.message.length > 500) return null;
    record.error = { code: value.error.code, message: value.error.message };
  }
  return record;
}

function terminalJob(current, input, now) {
  const base = {
    version: JOB_VERSION,
    jobId: current.jobId,
    status: input?.status,
    createdAt: current.createdAt,
    updatedAt: new Date(now).toISOString(),
    expiresAt: current.expiresAt
  };
  if (input?.status === 'complete') {
    if (!validAudioSource(input.source)) throw Object.assign(new Error('A valid audio source is required.'), { status: 400 });
    base.source = input.source;
    if (typeof input.traceId === 'string') {
      const traceId = input.traceId.trim();
      if (/^[A-Za-z0-9._:-]{1,200}$/.test(traceId)) base.traceId = traceId;
    }
    return base;
  }
  if (input?.status === 'failed') {
    const code = typeof input.error?.code === 'string' ? input.error.code.trim().slice(0, 80) : '';
    const message = typeof input.error?.message === 'string' ? input.error.message.trim().slice(0, 500) : '';
    if (!code || !message) throw Object.assign(new Error('A stable public error is required.'), { status: 400 });
    base.error = { code, message };
    return base;
  }
  throw Object.assign(new Error('Only complete or failed transitions are allowed.'), { status: 400 });
}

function sameTerminal(left, right) {
  return left.status === right.status && left.source === right.source && left.traceId === right.traceId &&
    left.error?.code === right.error?.code && left.error?.message === right.error?.message;
}

async function settleAbandonedJob(storage, result, jobId, currentTime) {
  const current = validStoredJob(result?.record, jobId);
  const stillRecoverable = current && Date.parse(current.expiresAt) > currentTime;
  const abandoned = stillRecoverable
    && current.status === 'pending'
    && Date.parse(current.updatedAt) + PENDING_JOB_TTL_MS <= currentTime;
  if (!abandoned) return result;

  const failed = terminalJob(current, {
    status: 'failed',
    error: {
      code: 'GENERATION_INTERRUPTED',
      message: 'The recording stopped before it could finish. Try the mehfil again.'
    }
  }, currentTime);
  const transitioned = await storage.transitionJob(jobId, failed, result.etag);
  if (!transitioned.conflict) return transitioned;
  return await storage.getJob(jobId);
}

async function readJobJson(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JOB_JSON_BYTES) throw Object.assign(new Error('Job update is too large.'), { status: 413 });
  const bytes = await readBody(request, MAX_JOB_JSON_BYTES);
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

function parseByteRange(header, size) {
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
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd) || offset >= size || requestedEnd < offset) return null;
  return { offset, length: Math.min(requestedEnd, size - 1) - offset + 1 };
}

function notFoundPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>This song has left the mehfil</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 20%,#315d55,#112f2d 55%,#081b1c);color:#f9edda;font:18px Georgia,serif;text-align:center}.card{max-width:34rem;padding:3rem}.moon{font-size:4rem;color:#e6a653}h1{font-size:clamp(2rem,8vw,4rem);margin:.5rem}p{line-height:1.6;color:#d9c9ae}a{color:#e6a653}</style><main class="card"><div class="moon">☾</div><h1>This song has left the mehfil.</h1><p>It may have finished its stay in the courtyard, but there is always room to make another.</p><a href="${REPOSITORY_URL}">Make your own song →</a></main></html>`;
}

export function createR2Storage(bucket) {
  const conditionalEtag = object => object?.etag || object?.httpEtag?.replace(/^"|"$/g, '');
  return {
    async put(id, share) {
      await bucket.put(`shares/${id}.mp3`, share.audio, {
        httpMetadata: { contentType: share.contentType, cacheControl: 'public, max-age=31536000, immutable' }
      });
      try {
        await bucket.put(`shares/${id}.json`, JSON.stringify(share.metadata), {
          httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=300' }
        });
      } catch (error) {
        await bucket.delete(`shares/${id}.mp3`);
        throw error;
      }
    },
    async getMetadata(id) {
      const object = await bucket.get(`shares/${id}.json`);
      if (!object) return null;
      try { return JSON.parse(await object.text()); } catch { return null; }
    },
    async getAudio(id, range) {
      const key = `shares/${id}.mp3`;
      if (!range) return bucket.get(key);
      const object = await bucket.head(key);
      if (!object) return null;
      const parsedRange = parseByteRange(range, object.size);
      if (!parsedRange) return { unsatisfiable: true, size: object.size };
      return bucket.get(key, { range: parsedRange });
    },
    async claimJob(id, record) {
      const object = await bucket.put(`jobs/${id}.json`, JSON.stringify(record), {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' }
      });
      if (!object) return { created: false };
      return { created: true, record, etag: conditionalEtag(object) };
    },
    async getJob(id) {
      const object = await bucket.get(`jobs/${id}.json`);
      if (!object) return null;
      try {
        return { record: JSON.parse(await object.text()), etag: conditionalEtag(object) };
      } catch { return null; }
    },
    async transitionJob(id, record, etag) {
      const object = await bucket.put(`jobs/${id}.json`, JSON.stringify(record), {
        onlyIf: { etagMatches: etag },
        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' }
      });
      if (!object) return { conflict: true };
      return { conflict: false, record, etag: conditionalEtag(object) };
    }
  };
}

export function createShareHandler({ storage, rateLimit = async () => true, idGenerator = deriveShareId, uploadSecret = '', publicBaseUrl = '', previewImageUrl = '', now = Date.now } = {}) {
  if (!storage) throw new Error('Share storage is required.');

  return async function handle(request) {
    const url = new URL(request.url);
    const claimMatch = url.pathname.match(/^\/generation-jobs\/([^/]+)\/claim$/);
    const jobMatch = url.pathname.match(/^\/generation-jobs\/([^/]+)$/);
    if ((claimMatch && request.method === 'POST') || (jobMatch && ['GET', 'PUT'].includes(request.method))) {
      if (!uploadSecret) return json({ error: 'Generation recovery is not configured.' }, 503);
      if (!await validBearer(request, uploadSecret)) return json({ error: 'Job credentials are missing or invalid.' }, 401, { 'www-authenticate': 'Bearer' });
      const jobId = (claimMatch || jobMatch)[1];
      if (!JOB_ID_PATTERN.test(jobId)) return json({ error: 'A valid generation job ID is required.' }, 400);

      try {
        if (claimMatch) {
          const currentTime = now();
          const record = pendingJob(jobId, currentTime);
          let result = await storage.claimJob(jobId, record);
          if (!result.created && !result.record) result = { ...result, ...await storage.getJob(jobId) };
          if (!result.created) result = await settleAbandonedJob(storage, result, jobId, currentTime);
          const stored = validStoredJob(result.record, jobId);
          if (!stored || Date.parse(stored.expiresAt) <= currentTime) return json({ error: 'Generation job is unavailable.' }, 404);
          return json(stored, result.created ? 201 : 200);
        }

        const currentTime = now();
        let currentResult = await storage.getJob(jobId);
        currentResult = await settleAbandonedJob(storage, currentResult, jobId, currentTime);
        const current = validStoredJob(currentResult?.record, jobId);
        if (!current || Date.parse(current.expiresAt) <= currentTime) return json({ error: 'Generation job was not found.' }, 404);
        if (request.method === 'GET') return json(current);

        const input = await readJobJson(request);
        const next = terminalJob(current, input, currentTime);
        if (current.status !== 'pending') return sameTerminal(current, next) ? json(current) : json({ error: 'Generation job is already finished.' }, 409);
        const transitioned = await storage.transitionJob(jobId, next, currentResult.etag);
        if (transitioned.conflict) {
          const winner = validStoredJob((await storage.getJob(jobId))?.record, jobId);
          if (winner && sameTerminal(winner, next)) return json(winner);
          return json({ error: 'Generation job changed concurrently.' }, 409);
        }
        return json(next);
      } catch (error) {
        return json({ error: error.message || 'Generation job request failed.' }, error.status || 503);
      }
    }

    if (request.method === 'POST' && url.pathname === '/shares') {
      if (!uploadSecret) return json({ error: 'Sharing is not configured.' }, 503);
      if (!await validBearer(request, uploadSecret)) {
        return json({ error: 'Upload credentials are missing or invalid.' }, 401, { 'www-authenticate': 'Bearer' });
      }
      const idempotencyKey = request.headers.get('idempotency-key') || '';
      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) return json({ error: 'A valid idempotency key is required.' }, 400);
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      if (!await rateLimit(ip)) return json({ error: 'Too many songs are arriving at once. Please try again in a minute.' }, 429, { 'retry-after': '60' });

      const declaredSize = Number(request.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > MAX_REQUEST_BYTES) return json({ error: 'Audio must be 10 MB or smaller.' }, 413);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) return json({ error: 'Send audio and song details as multipart form data.' }, 415);

      let form;
      try {
        const body = await readBody(request, MAX_REQUEST_BYTES);
        form = await new Request(request.url, { method: 'POST', headers: request.headers, body }).formData();
      } catch (error) {
        return json({ error: error.status === 413 ? error.message : 'Could not read the upload.' }, error.status || 400);
      }
      const audio = form.get('audio');
      if (!audio || typeof audio.arrayBuffer !== 'function') return json({ error: 'Add an MP3 recording.' }, 400);
      const contentType = String(audio.type || '').toLowerCase();
      if (!ALLOWED_AUDIO_TYPES.has(contentType)) return json({ error: 'Only MP3 audio can be shared.' }, 415);
      if (!audio.size || audio.size > MAX_AUDIO_BYTES) return json({ error: 'Audio must be 10 MB or smaller.' }, 413);

      let metadata;
      try { metadata = validateMetadata(form.get('metadata')); } catch (error) { return json({ error: error.message }, 400); }
      const id = await idGenerator(idempotencyKey, uploadSecret);
      if (!ID_PATTERN.test(id)) return json({ error: 'Could not create a share link.' }, 500);
      try {
        await storage.put(id, { audio: await audio.arrayBuffer(), contentType, metadata });
      } catch {
        return json({ error: 'The song could not be stored. Please retry.' }, 503);
      }
      return json({ id, url: `${url.origin}/s/${id}` }, 201);
    }

    const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{16})(?:\/(audio))?$/);
    if (match && (request.method === 'GET' || request.method === 'HEAD')) {
      const [, id, asset] = match;
      if (asset === 'audio') {
        const object = await storage.getAudio(id, request.headers.get('range'));
        if (!object) return new Response(null, { status: 404 });
        if (object.unsatisfiable) return new Response(null, { status: 416, headers: {
          'accept-ranges': 'bytes',
          'content-range': `bytes */${object.size}`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        } });
        const headers = new Headers({
          'content-type': object.httpMetadata?.contentType || object.contentType || 'audio/mpeg',
          'cache-control': 'public, max-age=31536000, immutable',
          'accept-ranges': 'bytes',
          'x-content-type-options': 'nosniff'
        });
        if (object.httpEtag || object.etag) headers.set('etag', object.httpEtag || object.etag);
        if (object.range && Number.isFinite(object.size)) {
          const offset = object.range.offset || 0;
          const length = object.range.length || object.size;
          headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
          headers.set('content-length', String(length));
          return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
        }
        if (Number.isFinite(object.size)) headers.set('content-length', String(object.size));
        return new Response(request.method === 'HEAD' ? null : object.body, { headers });
      }

      const song = await storage.getMetadata(id);
      if (!song) return new Response(request.method === 'HEAD' ? null : notFoundPage(), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      const nonce = randomId();
      const html = playbackPage(id, song, nonce, publicBaseUrl || url.origin, previewImageUrl);
      return new Response(request.method === 'HEAD' ? null : html, { headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'content-security-policy': `default-src 'none'; media-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors https://twitter.com https://*.twitter.com https://x.com https://*.x.com`,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff'
      } });
    }

    return json({ error: 'Not found.' }, 404);
  };
}

const roomCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8); crypto.getRandomValues(bytes);
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
};

export function createWorkerHandler({ shareHandler, rooms, rateLimit = async () => true, uploadSecret = '', roomPageRenderer = roomPage, codeGenerator = roomCode, hostSecretGenerator = () => { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return base64Url(bytes); } } = {}) {
  return async request => {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/rooms') {
      if (!uploadSecret) return json({ error: 'Rooms are not configured.' }, 503);
      if (!await validBearer(request, uploadSecret)) return json({ error: 'Room credentials are missing or invalid.' }, 401, { 'www-authenticate': 'Bearer' });
      if (!await rateLimit(request.headers.get('cf-connecting-ip') || 'unknown')) return json({ error: 'Too many rooms are opening at once. Please try again.' }, 429, { 'retry-after': '60' });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const roomId = codeGenerator();
        if (!ROOM_ID_PATTERN.test(roomId)) continue;
        const hostSecret = hostSecretGenerator();
        const openedAt = Date.now(); const expiresAt = openedAt + 6 * 60 * 60 * 1000;
        if (!await rooms.initialize(roomId, { hostDigest: await sha256(hostSecret), openedAt, expiresAt })) continue;
        return json({ roomId, joinUrl: `${url.origin}/r/${roomId}`, socketUrl: `${url.origin.replace(/^http/, 'ws')}/rooms/${roomId}/ws`, hostSecret, expiresAt }, 201);
      }
      return json({ error: 'Could not open a room. Please retry.' }, 503);
    }
    const join = url.pathname.match(/^\/r\/([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8})$/);
    if (join && (request.method === 'GET' || request.method === 'HEAD')) {
      const nonce = randomId(); const html = roomPageRenderer(join[1], nonce);
      return new Response(request.method === 'HEAD' ? null : html, { headers: {
        'content-type':'text/html; charset=utf-8','cache-control':'no-store',
        'content-security-policy':`default-src 'none'; connect-src 'self'; media-src 'self' blob:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'referrer-policy':'no-referrer','x-content-type-options':'nosniff'
      }});
    }
    const socket = url.pathname.match(/^\/rooms\/([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8})\/ws$/);
    if (socket && request.method === 'GET') return rooms.websocket(socket[1], request);
    return shareHandler(request);
  };
}

export class MehfilRoom {
  constructor(state) {
    this.state = state;
    const storage = { get:key => state.storage.get(key), put:(key,value) => state.storage.put(key,value) };
    this.transport = createRoomTransport({
      storage,
      randomId: () => randomId(),
      randomCredential: () => { const bytes=new Uint8Array(32); crypto.getRandomValues(bytes); return base64Url(bytes); },
      send: (socket, message) => socket?.send(JSON.stringify(message)),
      broadcast: fn => { for (const socket of state.getWebSockets()) if (socket.deserializeAttachment()?.authenticated) socket.send(JSON.stringify(fn(socket))); },
      close: (socket, code, reason) => socket?.close(code, reason),
      setAttachment: (socket, value) => socket.serializeAttachment(value),
      getAttachment: socket => socket?.deserializeAttachment(),
      setAlarm: value => state.storage.setAlarm(value),
      listSockets: () => state.getWebSockets()
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/initialize') {
      const data = await request.json();
      const created = await this.transport.initialize(data);
      return new Response(null, { status: created ? 201 : 409 });
    }
    if (url.pathname !== '/ws' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 });
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server); await this.transport.connect(server);
    setTimeout(() => this.transport.checkAuthenticationTimeout(server), 5_000);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket, message) { return this.transport.message(socket, message); }
  webSocketClose(socket) { return this.transport.disconnect(socket); }
  alarm() { return this.transport.alarm(); }
}

export default {
  fetch(request, env) {
    const storage = createR2Storage(env.SHARES);
    const rateLimit = async ip => (await env.UPLOAD_RATE_LIMIT.limit({ key: ip })).success;
    const shareHandler = createShareHandler({
      storage,
      rateLimit,
      uploadSecret: env.MEHFIL_SHARE_SECRET,
      publicBaseUrl: env.MEHFIL_PUBLIC_URL,
      previewImageUrl: env.SHARE_PREVIEW_IMAGE_URL
    });
    const rooms = {
      async initialize(roomId, data) {
        const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        return (await stub.fetch('https://room.internal/initialize', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ roomId, ...data }) })).status === 201;
      },
      websocket(roomId, roomRequest) {
        return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(new Request('https://room.internal/ws', roomRequest));
      }
    };
    return createWorkerHandler({ shareHandler, rooms, rateLimit, uploadSecret: env.MEHFIL_SHARE_SECRET })(request);
  }
};
