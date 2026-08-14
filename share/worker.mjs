const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 128 * 1024;
const ALLOWED_AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp3']);
const ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
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

function notFoundPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>This song has left the mehfil</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 20%,#315d55,#112f2d 55%,#081b1c);color:#f9edda;font:18px Georgia,serif;text-align:center}.card{max-width:34rem;padding:3rem}.moon{font-size:4rem;color:#e6a653}h1{font-size:clamp(2rem,8vw,4rem);margin:.5rem}p{line-height:1.6;color:#d9c9ae}a{color:#e6a653}</style><main class="card"><div class="moon">☾</div><h1>This song has left the mehfil.</h1><p>It may have finished its stay in the courtyard, but there is always room to make another.</p><a href="${REPOSITORY_URL}">Make your own song →</a></main></html>`;
}

function playbackPage(id, song, nonce) {
  const label = song.isLatinScript || !song.nativeScriptName
    ? song.language
    : `${song.language} · ${song.nativeScriptName}`;
  const data = scriptJson({
    native: song.lyricsNative.split('\n'),
    roman: song.lyricsRoman.split('\n')
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(song.title)} · Mini Mehfil</title><meta name="description" content="Listen to ${escapeHtml(song.title)} in the Mini Mehfil courtyard.">
<meta property="og:title" content="${escapeHtml(song.title)} · Mini Mehfil"><meta property="og:type" content="music.song">
<style nonce="${nonce}">
:root{color-scheme:dark;--ink:#f9edda;--amber:#e6a653;--teal:#123d39;--red:#9f4532}*{box-sizing:border-box}body{margin:0;min-height:100svh;overflow:hidden;background:#0d302f;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif}.courtyard{position:fixed;inset:0;background:radial-gradient(circle at 72% 12%,#f5c66f 0 3%,transparent 3.3%),linear-gradient(#48716a 0 32%,#bd6a47 58%,#172f2c 100%)}.courtyard:before{content:"";position:absolute;inset:9% -8% 0;border:clamp(28px,6vw,84px) solid #143a36;border-bottom:0;border-radius:50% 50% 0 0/36% 36% 0 0;box-shadow:inset 0 0 0 4px #31564d}.lights{position:absolute;top:12%;left:8%;right:8%;height:80px;border-top:2px solid #5b3424;border-radius:50%}.lights i{position:absolute;width:10px;height:16px;background:#ffd684;border-radius:50%;box-shadow:0 0 22px #ffd684}.lights i:nth-child(1){left:8%;top:6px}.lights i:nth-child(2){left:30%;top:24px}.lights i:nth-child(3){left:52%;top:29px}.lights i:nth-child(4){left:74%;top:20px}.lights i:nth-child(5){left:92%;top:4px}.stage{position:absolute;left:50%;bottom:10%;width:min(720px,90vw);height:30vh;transform:translateX(-50%);background:radial-gradient(ellipse at center bottom,#8f3d2f 0 40%,transparent 41%)}.stage:before{content:"♩  ◉  ♫  ◉  ♪";position:absolute;inset:25% 0 auto;text-align:center;color:#1f2825;font:clamp(2rem,8vw,5rem) Georgia;letter-spacing:.09em}.veil{position:fixed;inset:0;background:linear-gradient(transparent 28%,rgba(4,20,20,.28) 65%,rgba(4,15,16,.8))}.top{position:fixed;top:0;left:0;right:0;padding:20px max(20px,4vw);display:flex;justify-content:space-between;align-items:center}.brand{font:700 24px Georgia;color:var(--ink)}.brand small{display:block;color:var(--amber);font:italic 12px Georgia}.language{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#f5d19a}.performance{position:relative;z-index:1;min-height:100svh;display:grid;place-items:center;padding:90px 18px 150px;text-align:center}.sheet{width:min(760px,94vw);max-height:58svh;overflow:hidden;text-shadow:0 2px 14px #071817}.sheet h1{margin:0 0 24px;font:700 clamp(2rem,7vw,4.4rem) Georgia;color:#fff1d2}.line{margin:.35rem 0;font:600 clamp(1.05rem,3.3vw,1.65rem)/1.35 Georgia;animation:rise .55s both}.line.roman{margin-top:-.1rem;color:#f5c98c;font:italic 500 clamp(.82rem,2.5vw,1.05rem)/1.25 Georgia}.player{position:fixed;z-index:2;left:50%;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(720px,calc(100vw - 28px));display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:center;padding:13px 16px;background:rgba(8,28,28,.9);border:1px solid rgba(230,166,83,.45);border-radius:10px;backdrop-filter:blur(12px)}.start{grid-row:1/3;width:58px;height:58px;border:1px solid var(--amber);border-radius:50%;background:#873d2d;color:white;font-size:21px;cursor:pointer}.player strong{font:700 16px Georgia}.player audio{width:100%;height:32px}.cta{position:fixed;z-index:3;right:20px;bottom:116px;color:var(--ink);font-size:12px;text-decoration:none;border-bottom:1px solid var(--amber);padding-bottom:3px}@keyframes rise{from{opacity:0;transform:translateY(10px)}}@media(max-width:600px){.top{padding:16px 18px}.sheet{max-height:56svh}.cta{right:18px;bottom:112px}}
</style></head><body><div class="courtyard" aria-hidden="true"><div class="lights"><i></i><i></i><i></i><i></i><i></i></div><div class="stage"></div></div><div class="veil" aria-hidden="true"></div>
<header class="top"><div class="brand"><small>Mini</small>महफ़िल</div><span class="language">${escapeHtml(label)}</span></header>
<main class="performance"><section class="sheet" aria-live="polite"><h1>${escapeHtml(song.title)}</h1><div id="lyrics"></div></section></main>
<a class="cta" href="${REPOSITORY_URL}">Make your own song →</a>
<section class="player" aria-label="Song player"><button class="start" id="start" type="button" aria-label="Play ${escapeHtml(song.title)}">▶</button><strong>${escapeHtml(song.title)}</strong><audio id="audio" controls preload="metadata" src="/s/${id}/audio"></audio></section>
<script id="song-data" type="application/json">${data}</script><script nonce="${nonce}">const audio=document.querySelector('#audio'),start=document.querySelector('#start'),lyrics=document.querySelector('#lyrics'),song=JSON.parse(document.querySelector('#song-data').textContent);function sync(){const lines=Math.max(song.native.length,song.roman.length),duration=Number.isFinite(audio.duration)?audio.duration:0,count=duration?Math.min(lines,Math.ceil((audio.currentTime/(duration*.9))*lines)):0;lyrics.replaceChildren();for(let i=0;i<count;i++){const native=(song.native[i]||'').trim(),roman=(song.roman[i]||'').trim();if(native){const p=document.createElement('p');p.className='line';p.textContent=native;lyrics.append(p)}if(roman&&roman!==native){const p=document.createElement('p');p.className='line roman';p.textContent=roman;lyrics.append(p)}}lyrics.lastElementChild?.scrollIntoView({block:'nearest',behavior:'smooth'})}start.addEventListener('click',()=>audio.paused?audio.play():audio.pause());audio.addEventListener('play',()=>{start.textContent='❚❚';start.setAttribute('aria-label','Pause')});audio.addEventListener('pause',()=>{start.textContent='▶';start.setAttribute('aria-label','Play')});audio.addEventListener('timeupdate',sync);audio.addEventListener('seeked',sync);</script></body></html>`;
}

export function createR2Storage(bucket) {
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
      const options = range ? { range: new Headers({ range }) } : undefined;
      return bucket.get(`shares/${id}.mp3`, options);
    }
  };
}

export function createShareHandler({ storage, rateLimit = async () => true, idGenerator = randomId } = {}) {
  if (!storage) throw new Error('Share storage is required.');

  return async function handle(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/shares') {
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
      const id = idGenerator();
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
        const headers = new Headers({
          'content-type': object.httpMetadata?.contentType || object.contentType || 'audio/mpeg',
          'cache-control': 'public, max-age=31536000, immutable',
          'accept-ranges': 'bytes',
          'x-content-type-options': 'nosniff'
        });
        if (object.etag) headers.set('etag', object.etag);
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
      const html = playbackPage(id, song, nonce);
      return new Response(request.method === 'HEAD' ? null : html, { headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'content-security-policy': `default-src 'none'; media-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff'
      } });
    }

    return json({ error: 'Not found.' }, 404);
  };
}

export default {
  fetch(request, env) {
    const storage = createR2Storage(env.SHARES);
    const rateLimit = async ip => (await env.UPLOAD_RATE_LIMIT.limit({ key: ip })).success;
    return createShareHandler({ storage, rateLimit })(request);
  }
};
