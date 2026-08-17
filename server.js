const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SHARE_AUDIO_BYTES = 10 * 1024 * 1024;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const RECOVERY_TIMEOUT_MS = 15 * 1000;
const GENERATION_TIMEOUT_MS = 4 * 60 * 1000;
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
  if (typeof source !== 'string' || !source || source.length > 32 * 1024) return null;
  if (/^(?:0x)?[0-9a-f]+$/i.test(source) && source.replace(/^0x/i, '').length % 2 === 0) return source;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && !url.username && !url.password ? source : null;
  } catch { return null; }
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
  const hex = source.replace(/^0x/i, '');
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw Object.assign(new Error('The finished recording is unavailable.'), { status: 400 });
  const audio = Buffer.from(hex, 'hex');
  if (audio.length > MAX_SHARE_AUDIO_BYTES) throw Object.assign(new Error('The recording is larger than the 10 MB sharing limit.'), { status: 413 });
  return audio;
}

function normalizeShareBaseUrl(value) {
  if (!value) return '';
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

function completedGeneration(record) {
  const result = {
    jobId: record.jobId,
    status: 'complete',
    data: { audio: record.source },
    share_ref: record.jobId
  };
  if (record.traceId) result.trace_id = record.traceId;
  return result;
}

function publicFailure(message, code = 'GENERATION_FAILED') {
  const upstream = typeof message === 'string' ? message : '';
  let safe = 'MiniMax could not make the recording. Please try again.';
  if (/token|auth|unauthori[sz]ed|forbidden/i.test(upstream)) safe = 'MiniMax rejected the API token. Check it and try again.';
  else if (/rate|quota|limit|too many/i.test(upstream)) safe = 'MiniMax is handling too many requests. Please try again shortly.';
  else if (code === 'GENERATION_TIMEOUT') safe = 'The recording took too long to finish. Try the mehfil again.';
  else if (code === 'MISSING_AUDIO') safe = 'MiniMax succeeded but did not return an audio file.';
  else if (code === 'MINIMAX_UNAVAILABLE') safe = 'Generation failed while contacting MiniMax.';
  return { code, message: safe };
}

function staticFile(req, res, shareBaseUrl = '') {
  const pathname = new URL(req.url, 'http://localhost').pathname;
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
    const roomSources = shareBaseUrl
      ? `${shareBaseUrl} ${shareBaseUrl.replace(/^https:/, 'wss:')}`
      : '';
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'self'; connect-src 'self' https://*.minimax.io${roomSources ? ` ${roomSources}` : ''}; media-src 'self' https: blob:; img-src 'self' data: https:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'`
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
  const shareBaseUrl = normalizeShareBaseUrl(options.shareBaseUrl ?? process.env.MEHFIL_SHARE_URL ?? '');
  const vercelProductionHostname = options.vercelProjectProductionUrl ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const vercelProductionUrl = vercelProductionHostname
    ? `https://${vercelProductionHostname}`
    : '';
  const publicBaseUrl = normalizeShareBaseUrl(options.publicBaseUrl ?? process.env.MEHFIL_PUBLIC_URL ?? vercelProductionUrl);
  const shareSecret = String(options.shareSecret ?? process.env.MEHFIL_SHARE_SECRET ?? '').trim();
  const sharingConfigured = Boolean(shareBaseUrl && shareSecret);
  const generationTimeoutMs = options.generationTimeoutMs ?? GENERATION_TIMEOUT_MS;
  const sharedUrls = new Map();

  async function recoveryRequest(pathname, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RECOVERY_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(`${shareBaseUrl}${pathname}`, {
        method,
        headers: {
          'Authorization': `Bearer ${shareSecret}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } catch {
      throw Object.assign(new Error('Recording recovery is temporarily unavailable. Please check again.'), { status: 503 });
    } finally {
      clearTimeout(timeout);
    }
    let value;
    try { value = JSON.parse(await response.text()); } catch {
      throw Object.assign(new Error('Recording recovery returned an unreadable response. Please check again.'), { status: 503 });
    }
    return { response, value };
  }

  async function checkpointFailure(jobId, failure) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const checkpoint = await recoveryRequest(`/generation-jobs/${jobId}`, { method: 'PUT', body: { status: 'failed', error: failure } });
        if (checkpoint.response.ok) return true;
      } catch {}
    }
    return false;
  }

  async function checkpointComplete(jobId, completion) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const checkpoint = await recoveryRequest(`/generation-jobs/${jobId}`, { method: 'PUT', body: completion });
        if (checkpoint.response.ok) return checkpoint.value;
      } catch {}
    }
    return null;
  }
  const roomTimeoutMs = options.roomTimeoutMs || 2 * 60 * 1000;
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
      let claimedJobId = '';
      let paidCallStarted = false;
      let audioReady = false;
      try {
        const body = await readJson(req);
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        const lyrics = typeof body.lyrics === 'string' ? body.lyrics.trim() : '';
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        const jobId = typeof body.jobId === 'string' ? body.jobId : '';

        if (!token) return sendJson(res, 400, { error: 'Add your MiniMax API token.' });
        if (!lyrics) return sendJson(res, 400, { error: 'Add some lyrics first.' });
        if (lyrics.length > 3500) return sendJson(res, 400, { error: 'Lyrics must be 3,500 characters or fewer.' });
        if (prompt.length > 2000) return sendJson(res, 400, { error: 'Sound description must be 2,000 characters or fewer.' });
        if (sharingConfigured && !JOB_ID_PATTERN.test(jobId)) return sendJson(res, 400, { error: 'A valid generation job ID is required.' });

        if (sharingConfigured) {
          const claim = await recoveryRequest(`/generation-jobs/${jobId}/claim`, { method: 'POST' });
          if (!claim.response.ok) return sendJson(res, 503, { error: claim.value.error || 'Recording recovery is temporarily unavailable. Please check again.' });
          if (claim.response.status === 200) {
            if (claim.value.status === 'complete') return sendJson(res, 200, completedGeneration(claim.value));
            if (claim.value.status === 'failed') return sendJson(res, 400, { error: claim.value.error?.message || 'Generation failed.' });
            return sendJson(res, 202, { jobId, status: 'pending' });
          }
          claimedJobId = jobId;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), generationTimeoutMs);
        let upstream;
        try {
          paidCallStarted = true;
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
          const failure = publicFailure(String(message), 'MINIMAX_FAILED');
          if (claimedJobId && !await checkpointFailure(claimedJobId, failure)) return sendJson(res, 503, { error: 'Generation ended, but recovery could not save its final status. Please check again.' });
          return sendJson(res, upstream.ok ? 400 : upstream.status, { error: failure.message });
        }
        const source = audioSource(result);
        if (!source) {
          const failure = publicFailure('MiniMax succeeded but did not return an audio file.', 'MISSING_AUDIO');
          if (claimedJobId && !await checkpointFailure(claimedJobId, failure)) return sendJson(res, 503, { error: 'Generation ended, but recovery could not save its final status. Please check again.' });
          return sendJson(res, 502, { error: failure.message });
        }
        audioReady = true;
        if (claimedJobId) {
          const traceId = result?.trace_id || result?.traceId || result?.data?.trace_id;
          const checkpoint = await checkpointComplete(claimedJobId, {
            status: 'complete', source, ...(typeof traceId === 'string' ? { traceId } : {})
          });
          if (!checkpoint) return sendJson(res, 503, { error: 'Your recording finished, but its recovery checkpoint could not be saved. Start a new song when you are ready.' });
          return sendJson(res, 200, completedGeneration(checkpoint));
        }
        return sendJson(res, 200, result);
      } catch (error) {
        if (error.name === 'AbortError') {
          const failure = publicFailure('Generation timed out.', 'GENERATION_TIMEOUT');
          if (claimedJobId && !await checkpointFailure(claimedJobId, failure)) return sendJson(res, 503, { error: 'Generation ended, but recovery could not save its final status. Please check again.' });
          return sendJson(res, 504, { error: failure.message });
        }
        if (claimedJobId && paidCallStarted && !audioReady) {
          const failure = publicFailure('Generation failed while contacting MiniMax.', 'MINIMAX_UNAVAILABLE');
          if (!await checkpointFailure(claimedJobId, failure)) return sendJson(res, 503, { error: 'Generation ended, but recovery could not save its final status. Please check again.' });
          return sendJson(res, 502, { error: failure.message });
        }
        return sendJson(res, error.status || 500, { error: error.message || 'Generation failed.' });
      }
    }

    if (req.method === 'GET' && new URL(req.url, 'http://localhost').pathname === '/api/generation-status') {
      const jobId = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
      if (!JOB_ID_PATTERN.test(jobId)) return sendJson(res, 400, { error: 'A valid generation job ID is required.' });
      if (!sharingConfigured) return sendJson(res, 503, { error: 'This deployment cannot recover a recording after the page loses its response.' });
      try {
        const status = await recoveryRequest(`/generation-jobs/${jobId}`);
        if (status.response.status === 404) return sendJson(res, 404, { error: 'That recording can no longer be recovered.' });
        if (!status.response.ok) return sendJson(res, 503, { error: 'Recording recovery is temporarily unavailable. Please check again.' });
        if (status.value.status === 'complete') return sendJson(res, 200, completedGeneration(status.value));
        if (status.value.status === 'failed') return sendJson(res, 200, { jobId, status: 'failed', error: status.value.error?.message || 'Generation failed.' });
        return sendJson(res, 200, { jobId, status: 'pending' });
      } catch (error) {
        return sendJson(res, error.status || 503, { error: error.message || 'Recording recovery is temporarily unavailable. Please check again.' });
      }
    }

    if (req.method === 'POST' && req.url === '/api/share') {
      try {
        if (!sharingConfigured) return sendJson(res, 503, { error: 'Sharing is not configured on this mehfil.' });
        const body = await readJson(req);
        const shareReference = typeof body.shareRef === 'string' ? body.shareRef : '';
        if (!JOB_ID_PATTERN.test(shareReference)) return sendJson(res, 404, { error: 'That recording is no longer ready to share. Make it again and retry.' });
        if (sharedUrls.has(shareReference)) return sendJson(res, 201, { url: sharedUrls.get(shareReference) });
        const recovered = await recoveryRequest(`/generation-jobs/${shareReference}`);
        if (!recovered.response.ok || recovered.value.status !== 'complete') return sendJson(res, 404, { error: 'That recording is no longer ready to share. Make it again and retry.' });
        const entry = { source: recovered.value.source };

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
          response = await fetchImpl(`${shareBaseUrl}/shares`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${shareSecret}`,
              'Idempotency-Key': shareReference
            },
            body: form,
            signal: controller.signal
          });
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
        const cleanUrl = `${publicBaseUrl || publicUrl.origin}${publicUrl.pathname}`;
        sharedUrls.set(shareReference, cleanUrl);
        return sendJson(res, 201, { url: cleanUrl });
      } catch (error) {
        if (error.name === 'AbortError') return sendJson(res, 504, { error: 'Sharing took too long. Please retry.' });
        return sendJson(res, error.status || 502, { error: error.message || 'The song could not be shared. Please retry.' });
      }
    }

    if (req.method === 'POST' && req.url === '/api/rooms') {
      try {
        if (!sharingConfigured) return sendJson(res, 503, { error: 'Live rooms are not configured on this mehfil.' });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), roomTimeoutMs);
        let response;
        try {
          response = await fetchImpl(`${shareBaseUrl}/rooms`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${shareSecret}`, 'Content-Type': 'application/json' },
            body: '{}',
            signal: controller.signal
          });
        } finally { clearTimeout(timeout); }
        const text = await response.text();
        let result; try { result = JSON.parse(text); } catch { result = { error: 'The room service returned an unreadable response.' }; }
        if (!response.ok) return sendJson(res, response.status, { error: result.error || 'The room could not be opened.' });
        const roomId = typeof result.roomId === 'string' ? result.roomId : '';
        if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(roomId)) throw Object.assign(new Error('The room service returned invalid room details.'), { status: 502 });
        let joinUrl; let socketUrl;
        try { joinUrl = new URL(result.joinUrl); socketUrl = new URL(result.socketUrl); } catch { throw Object.assign(new Error('The room service returned invalid room details.'), { status: 502 }); }
        const configured = new URL(shareBaseUrl);
        const validJoin = joinUrl.protocol === 'https:' && joinUrl.origin === configured.origin && joinUrl.pathname === `/r/${roomId}` && !joinUrl.search && !joinUrl.hash && !joinUrl.username && !joinUrl.password;
        const validSocket = socketUrl.protocol === 'wss:' && socketUrl.host === configured.host && socketUrl.pathname === `/rooms/${roomId}/ws` && !socketUrl.search && !socketUrl.hash && !socketUrl.username && !socketUrl.password;
        const validSecret = typeof result.hostSecret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(result.hostSecret);
        const expiresAt = Number(result.expiresAt);
        if (!validJoin || !validSocket || !validSecret || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw Object.assign(new Error('The room service returned invalid room details.'), { status: 502 });
        return sendJson(res, 201, { roomId, joinUrl: joinUrl.href, socketUrl: socketUrl.href, hostSecret: result.hostSecret, expiresAt });
      } catch (error) {
        if (error.name === 'AbortError') return sendJson(res, 504, { error: 'Opening the room took too long. Please retry.' });
        return sendJson(res, error.status || 502, { error: error.message || 'The room could not be opened.' });
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') return staticFile(req, res, shareBaseUrl);
    res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end('Method not allowed');
  });
}

const server = createServer();

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  server.listen(port, '127.0.0.1', () => {
    console.log(`Mehfil is open at http://127.0.0.1:${port}`);
  });
}

// Vercel's Node runtime requires the CommonJS default export to be a request
// handler or HTTP server. Keep createServer attached for isolated tests.
module.exports = server;
module.exports.createServer = createServer;
