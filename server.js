const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { issueShareTicket, verifyShareTicket } = require('./share-ticket');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SHARE_AUDIO_BYTES = 10 * 1024 * 1024;
const SHARE_REFERENCE_TTL_MS = 30 * 60 * 1000;
/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} value */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<unknown>}
 */
function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    /** @param {Buffer} chunk */
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request is too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} key @returns {unknown} */
function property(value, key) {
  return isRecord(value) ? value[key] : undefined;
}

/** @param {unknown} error @returns {boolean} */
function isAbortError(error) {
  return property(error, 'name') === 'AbortError';
}

/** @param {unknown} error @param {number} fallback @returns {number} */
function errorStatus(error, fallback) {
  const status = property(error, 'status');
  return typeof status === 'number' ? status : fallback;
}

/** @param {unknown} error @param {string} fallback @returns {string} */
function errorMessage(error, fallback) {
  const message = property(error, 'message');
  return typeof message === 'string' && message ? message : fallback;
}

/** @param {unknown} result @returns {string | null} */
function audioSource(result) {
  const audio = property(result, 'audio');
  const source = property(property(result, 'data'), 'audio') || property(audio, 'url') || audio;
  return typeof source === 'string' && source ? source : null;
}

/** @param {Response} response @param {number} limit @returns {Promise<Buffer>} */
async function readLimitedBody(response, limit) {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > limit) throw Object.assign(new Error('The recording is larger than the 10 MB sharing limit.'), { status: 413 });
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Object.assign(new Error('The recording is larger than the 10 MB sharing limit.'), { status: 413 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

/** @param {unknown} value @returns {string} */
function normalizeShareBaseUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    const localHttp = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (url.protocol !== 'https:' && !localHttp) return '';
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return '';
    return url.origin;
  } catch {
    return '';
  }
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
function staticFile(req, res) {
  const pathname = new URL(req.url || '', 'http://localhost').pathname;
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requestPath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' https://*.minimax.io; media-src 'self' https: blob:; img-src 'self' data: https:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'"
    });
    res.end(data);
  });
}

// pi-ai is ESM-only and this server is CommonJS, so the lyricist loads on first use.
// It also keeps startup fast and lets the music path work even if the lyricist fails.
/** @type {Promise<typeof import('./lyricist.mjs')> | undefined} */
let lyricistPromise;
/** @returns {Promise<typeof import('./lyricist.mjs')>} */
function loadLyricist() {
  lyricistPromise = lyricistPromise || import('./lyricist.mjs');
  return lyricistPromise;
}

/** @param {import('./types/contracts').CreateServerOptions} [options] */
function createServer(options = {}) {
  const apiBase = options.apiBase || process.env.MINIMAX_API_BASE || 'https://api.minimax.io';
  const fetchImpl = options.fetchImpl || global.fetch;
  const writeLyricsImpl = options.writeLyrics;
  const shareBaseUrl = normalizeShareBaseUrl(options.shareBaseUrl ?? process.env.MEHFIL_SHARE_URL ?? '');
  const shareSecret = String(options.shareSecret ?? process.env.MEHFIL_SHARE_SECRET ?? '').trim();
  const sharingConfigured = Boolean(shareBaseUrl && shareSecret);
  return http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/write-lyrics') {
      try {
        const parsedBody = await readJson(req);
        const body = isRecord(parsedBody) ? parsedBody : {};
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        const idea = typeof body.idea === 'string' ? body.idea.trim() : '';
        const vibe = typeof body.vibe === 'string' ? body.vibe.trim() : '';
        const language = typeof body.language === 'string' ? body.language.trim() : 'auto';

        if (!token) return sendJson(res, 400, { error: 'Add your MiniMax API token.' });
        if (!idea) return sendJson(res, 400, { error: 'Tell me what the song is about.' });
        if (idea.length > 400) return sendJson(res, 400, { error: 'Keep the idea under 400 characters.' });
        if (vibe.length > 400) return sendJson(res, 400, { error: 'Keep the vibe under 400 characters.' });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2 * 60 * 1000);
        try {
          const writeLyrics = writeLyricsImpl || (await loadLyricist()).writeLyrics;
          const result = await writeLyrics({ token, idea, vibe, language, signal: controller.signal });
          return sendJson(res, 200, result);
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        if (isAbortError(error)) return sendJson(res, 504, { error: 'The lyricist took too long. Try again.' });
        return sendJson(res, errorStatus(error, 502), { error: errorMessage(error, 'Could not write lyrics.') });
      }
    }

    if (req.method === 'POST' && req.url === '/api/generate') {
      try {
        const parsedBody = await readJson(req);
        const body = isRecord(parsedBody) ? parsedBody : {};
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        const lyrics = typeof body.lyrics === 'string' ? body.lyrics.trim() : '';
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

        if (!token) return sendJson(res, 400, { error: 'Add your MiniMax API token.' });
        if (!lyrics) return sendJson(res, 400, { error: 'Add some lyrics first.' });
        if (lyrics.length > 3500) return sendJson(res, 400, { error: 'Lyrics must be 3,500 characters or fewer.' });
        if (prompt.length > 2000) return sendJson(res, 400, { error: 'Sound description must be 2,000 characters or fewer.' });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 7 * 60 * 1000);
        let upstream;
        try {
          upstream = await fetchImpl(`${apiBase}/v1/music_generation`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'music-3.0',
              prompt: prompt || 'Warm contemporary Indian pop with natural native pronunciation, expressive vocals, organic instrumentation, and a memorable melodic chorus.',
              lyrics,
              audio_setting: {
                sample_rate: 44100,
                bitrate: 256000,
                format: 'mp3'
              },
              output_format: 'url',
              stream: false
            }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeout);
        }

        const text = await upstream.text();
        /** @type {unknown} */
        let result;
        try { result = JSON.parse(text); } catch { result = { error: text || 'MiniMax returned an unreadable response.' }; }

        if (!upstream.ok || property(property(result, 'base_resp'), 'status_code')) {
          const resultError = property(result, 'error');
          const message = property(property(result, 'base_resp'), 'status_msg') || property(resultError, 'message') || resultError || `MiniMax request failed (${upstream.status})`;
          return sendJson(res, upstream.ok ? 400 : upstream.status, { error: String(message), details: result });
        }
        const source = audioSource(result);
        if (source && sharingConfigured && isRecord(result)) {
          try {
            result.share_ref = issueShareTicket({
              source,
              expiresAt: Date.now() + SHARE_REFERENCE_TTL_MS,
              secret: shareSecret
            });
          } catch {
            // Inline and otherwise invalid audio sources remain playable locally,
            // but are intentionally unavailable to the sharing endpoint.
          }
        }
        return sendJson(res, 200, result);
      } catch (error) {
        if (isAbortError(error)) return sendJson(res, 504, { error: 'Generation timed out after seven minutes.' });
        return sendJson(res, errorStatus(error, 500), { error: errorMessage(error, 'Generation failed.') });
      }
    }

    if (req.method === 'POST' && req.url === '/api/share') {
      try {
        if (!sharingConfigured) return sendJson(res, 503, { error: 'Sharing is not configured on this mehfil.' });
        const parsedBody = await readJson(req);
        const body = isRecord(parsedBody) ? parsedBody : {};
        const shareReference = typeof body.shareRef === 'string' ? body.shareRef : '';
        let ticket;
        try {
          ticket = verifyShareTicket(shareReference, { now: Date.now(), secret: shareSecret });
        } catch {
          return sendJson(res, 404, { error: 'That recording is no longer ready to share. Make it again and retry.' });
        }

        /** @type {import('./types/contracts').SharedSongMetadata} */
        const metadata = {
          title: typeof body.title === 'string' ? body.title : '',
          language: typeof body.language === 'string' ? body.language : '',
          nativeScriptName: typeof body.nativeScriptName === 'string' ? body.nativeScriptName : '',
          isLatinScript: Boolean(body.isLatinScript),
          lyricsNative: typeof body.lyricsNative === 'string' ? body.lyricsNative : '',
          lyricsRoman: typeof body.lyricsRoman === 'string' ? body.lyricsRoman : ''
        };

        const downloadController = new AbortController();
        const downloadTimeout = setTimeout(() => downloadController.abort(), 2 * 60 * 1000);
        let audio;
        try {
          const response = await fetchImpl(ticket.source, { signal: downloadController.signal });
          if (!response.ok) throw Object.assign(new Error('The finished recording could not be downloaded. Please retry.'), { status: 502 });
          audio = await readLimitedBody(response, MAX_SHARE_AUDIO_BYTES);
        } finally {
          clearTimeout(downloadTimeout);
        }
        if (!audio.length) throw Object.assign(new Error('The finished recording is empty.'), { status: 502 });

        const form = new FormData();
        form.set('audio', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'mehfil-song.mp3');
        form.set('metadata', JSON.stringify(metadata));
        // This endpoint stays stateless across serverless instances. A retry may
        // repeat the transfer; the stable Worker key deduplicates share creation.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2 * 60 * 1000);
        let response;
        try {
          response = await fetchImpl(`${shareBaseUrl}/shares`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${shareSecret}`,
              'Idempotency-Key': ticket.idempotencyKey
            },
            body: form,
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeout);
        }
        const text = await response.text();
        /** @type {unknown} */
        let result;
        try { result = JSON.parse(text); } catch { result = { error: 'The share service returned an unreadable response.' }; }
        if (!response.ok) return sendJson(res, response.status, { error: property(result, 'error') || 'The song could not be shared.' });
        let publicUrl;
        try { publicUrl = new URL(String(property(result, 'url') || '')); } catch { throw Object.assign(new Error('The share service returned an invalid link.'), { status: 502 }); }
        const configuredOrigin = new URL(shareBaseUrl).origin;
        if (publicUrl.origin !== configuredOrigin || !/^\/s\/[A-Za-z0-9_-]{16}$/.test(publicUrl.pathname)) {
          throw Object.assign(new Error('The share service returned an invalid link.'), { status: 502 });
        }
        return sendJson(res, 201, { url: publicUrl.href });
      } catch (error) {
        if (isAbortError(error)) return sendJson(res, 504, { error: 'Sharing took too long. Please retry.' });
        return sendJson(res, errorStatus(error, 502), { error: errorMessage(error, 'The song could not be shared. Please retry.') });
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') return staticFile(req, res);
    res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end('Method not allowed');
  });
}

const server = Object.assign(createServer(), { createServer });

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  server.listen(port, '127.0.0.1', () => {
    console.log(`Mehfil is open at http://127.0.0.1:${port}`);
  });
}

// Vercel's Node runtime requires the CommonJS default export to be a request
// handler or HTTP server. Keep createServer attached for isolated tests.
module.exports = server;
