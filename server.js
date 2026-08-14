const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SHARE_AUDIO_BYTES = 10 * 1024 * 1024;
const SHARE_REFERENCE_TTL_MS = 30 * 60 * 1000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
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

function audioSource(result) {
  const source = result?.data?.audio || result?.audio?.url || result?.audio;
  return typeof source === 'string' && source ? source : null;
}

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

function decodeAudioSource(source) {
  if (/^https:\/\//i.test(source)) return null;
  const hex = source.startsWith('0x') ? source.slice(2) : source;
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw Object.assign(new Error('The finished recording is unavailable.'), { status: 400 });
  const audio = Buffer.from(hex, 'hex');
  if (audio.length > MAX_SHARE_AUDIO_BYTES) throw Object.assign(new Error('The recording is larger than the 10 MB sharing limit.'), { status: 413 });
  return audio;
}

function staticFile(req, res) {
  const requestPath = req.url === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname;
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
let lyricistPromise;
function loadLyricist() {
  lyricistPromise = lyricistPromise || import('./lyricist.mjs');
  return lyricistPromise;
}

function createServer(options = {}) {
  const apiBase = options.apiBase || process.env.MINIMAX_API_BASE || 'https://api.minimax.io';
  const fetchImpl = options.fetchImpl || global.fetch;
  const writeLyricsImpl = options.writeLyrics;
  const shareBaseUrl = (options.shareBaseUrl ?? process.env.MEHFIL_SHARE_URL ?? '').replace(/\/$/, '');
  const generatedAudio = new Map();

  return http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/write-lyrics') {
      try {
        const body = await readJson(req);
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
        if (error.name === 'AbortError') return sendJson(res, 504, { error: 'The lyricist took too long. Try again.' });
        return sendJson(res, error.status || 502, { error: error.message || 'Could not write lyrics.' });
      }
    }

    if (req.method === 'POST' && req.url === '/api/generate') {
      try {
        const body = await readJson(req);
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
        let result;
        try { result = JSON.parse(text); } catch { result = { error: text || 'MiniMax returned an unreadable response.' }; }

        if (!upstream.ok || result?.base_resp?.status_code) {
          const message = result?.base_resp?.status_msg || result?.error?.message || result?.error || `MiniMax request failed (${upstream.status})`;
          return sendJson(res, upstream.ok ? 400 : upstream.status, { error: String(message), details: result });
        }
        const source = audioSource(result);
        if (source && shareBaseUrl) {
          const shareReference = crypto.randomBytes(18).toString('base64url');
          const now = Date.now();
          for (const [key, entry] of generatedAudio) {
            if (entry.expiresAt <= now) generatedAudio.delete(key);
          }
          generatedAudio.set(shareReference, { source, expiresAt: now + SHARE_REFERENCE_TTL_MS });
          result.share_ref = shareReference;
        }
        return sendJson(res, 200, result);
      } catch (error) {
        if (error.name === 'AbortError') return sendJson(res, 504, { error: 'Generation timed out after seven minutes.' });
        return sendJson(res, error.status || 500, { error: error.message || 'Generation failed.' });
      }
    }

    if (req.method === 'POST' && req.url === '/api/share') {
      try {
        if (!shareBaseUrl) return sendJson(res, 503, { error: 'Sharing is not configured on this mehfil.' });
        const body = await readJson(req);
        const shareReference = typeof body.shareRef === 'string' ? body.shareRef : '';
        const entry = generatedAudio.get(shareReference);
        if (!entry || entry.expiresAt <= Date.now()) {
          generatedAudio.delete(shareReference);
          return sendJson(res, 404, { error: 'That recording is no longer ready to share. Make it again and retry.' });
        }

        const metadata = {
          title: typeof body.title === 'string' ? body.title : '',
          language: typeof body.language === 'string' ? body.language : '',
          nativeScriptName: typeof body.nativeScriptName === 'string' ? body.nativeScriptName : '',
          isLatinScript: Boolean(body.isLatinScript),
          lyricsNative: typeof body.lyricsNative === 'string' ? body.lyricsNative : '',
          lyricsRoman: typeof body.lyricsRoman === 'string' ? body.lyricsRoman : ''
        };

        let audio = decodeAudioSource(entry.source);
        if (!audio) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2 * 60 * 1000);
          try {
            const response = await fetchImpl(entry.source, { signal: controller.signal });
            if (!response.ok) throw Object.assign(new Error('The finished recording could not be downloaded. Please retry.'), { status: 502 });
            audio = await readLimitedBody(response, MAX_SHARE_AUDIO_BYTES);
          } finally {
            clearTimeout(timeout);
          }
        }
        if (!audio.length) throw Object.assign(new Error('The finished recording is empty.'), { status: 502 });

        const form = new FormData();
        form.set('audio', new Blob([audio], { type: 'audio/mpeg' }), 'mehfil-song.mp3');
        form.set('metadata', JSON.stringify(metadata));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2 * 60 * 1000);
        let response;
        try {
          response = await fetchImpl(`${shareBaseUrl}/shares`, { method: 'POST', body: form, signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); } catch { result = { error: 'The share service returned an unreadable response.' }; }
        if (!response.ok) return sendJson(res, response.status, { error: result.error || 'The song could not be shared.' });
        let publicUrl;
        try { publicUrl = new URL(result.url); } catch { throw Object.assign(new Error('The share service returned an invalid link.'), { status: 502 }); }
        const configuredOrigin = new URL(shareBaseUrl).origin;
        if (publicUrl.origin !== configuredOrigin || !/^\/s\/[A-Za-z0-9_-]{16}$/.test(publicUrl.pathname)) {
          throw Object.assign(new Error('The share service returned an invalid link.'), { status: 502 });
        }
        generatedAudio.delete(shareReference);
        return sendJson(res, 201, { url: publicUrl.href });
      } catch (error) {
        if (error.name === 'AbortError') return sendJson(res, 504, { error: 'Sharing took too long. Please retry.' });
        return sendJson(res, error.status || 502, { error: error.message || 'The song could not be shared. Please retry.' });
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') return staticFile(req, res);
    res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end('Method not allowed');
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Mehfil is open at http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer };
