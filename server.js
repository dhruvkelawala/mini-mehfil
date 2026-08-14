const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 64 * 1024;
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
        if (lyrics.length > 3000) return sendJson(res, 400, { error: 'Lyrics must be 3,000 characters or fewer.' });
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
        return sendJson(res, 200, result);
      } catch (error) {
        if (error.name === 'AbortError') return sendJson(res, 504, { error: 'Generation timed out after seven minutes.' });
        return sendJson(res, error.status || 500, { error: error.message || 'Generation failed.' });
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
