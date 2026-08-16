import { COURTYARD_SCENE } from './courtyard.mjs';
import { installRoomClient } from './room-client.mjs';

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

export function roomPage(roomId, nonce) {
  // Wrangler decorates preserved function names with private __name(...) calls.
  // Function#toString cannot carry that module-scoped helper into this page.
  const client = `const __name = value => value;(${installRoomClient.toString()})(${scriptJson({ roomId })});`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#1f4238">
  <title>Room ${escapeHtml(roomId)} · Mini Mehfil</title>
  <style nonce="${nonce}">
    :root { --ink: #f9edda; --muted: #ddcbb8; --night: #142e2d; --amber: #e6a653; --terra: #7a362d; }
    * { box-sizing: border-box; }
    ::selection { color: #fff8ec; background: #9f4939; }
    :focus-visible { outline: 2px solid var(--amber); outline-offset: 3px; }
    body { margin: 0; min-height: 100svh; color: var(--ink); background: var(--night); font-family: "Avenir Next", sans-serif; }
    .scene, .scene svg { position: fixed; inset: 0; z-index: -2; width: 100%; height: 100%; }
    .scene::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(7,25,24,.74), rgba(7,25,24,.48) 48%, rgba(7,25,24,.68)); }
    .scene.is-performing { filter: saturate(1.1); }
    main {
      width: min(1120px, calc(100% - 40px)); min-height: 100svh; margin: auto; padding: clamp(40px, 8svh, 96px) 0 100px;
      display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(360px, .85fr); align-content: center; align-items: center; gap: clamp(40px, 8vw, 104px);
    }
    .room-intro { max-width: 600px; text-shadow: 0 4px 24px rgba(0,0,0,.38); }
    .room-intro h1 { max-width: 12ch; margin: 0; font: 700 clamp(52px, 7vw, 82px)/.98 "Iowan Old Style", Georgia, serif; letter-spacing: -.035em; text-wrap: balance; }
    .invitation { max-width: 38ch; margin: 24px 0 0; color: #ead6bc; font: italic clamp(18px, 2vw, 23px)/1.5 "Iowan Old Style", Georgia, serif; }
    .room-meta { display: flex; align-items: center; gap: 12px; margin-top: 30px; color: var(--muted); font-size: 12px; letter-spacing: .04em; }
    .room-meta strong { color: var(--ink); font-variant-numeric: tabular-nums; letter-spacing: .12em; }
    .status { min-height: 1.5em; margin: 0; }
    .status::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: var(--amber); box-shadow: 0 2px 10px rgba(230,166,83,.5); }
    .join-card {
      padding: 28px; border-radius: 14px; background: linear-gradient(155deg, rgba(15,42,39,.96), rgba(56,31,25,.94));
      box-shadow: 0 28px 80px rgba(4,15,14,.48); backdrop-filter: blur(16px);
    }
    .join-card h2 { margin: 0; font: 700 34px/1.05 "Iowan Old Style", Georgia, serif; letter-spacing: -.025em; }
    .join-copy { margin: 10px 0 24px; color: #d9c3aa; font-size: 14px; line-height: 1.55; }
    .card { margin: 16px 0; padding: 22px; border: 1px solid #ffffff35; border-radius: 14px; background: #142e2de8; backdrop-filter: blur(12px); }
    h2 { font-family: "Iowan Old Style", Georgia, serif; }
    label { display: block; margin: 12px 0 6px; color: #e8c891; font-size: 11px; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
    label span { color: #c6af95; font-weight: 650; letter-spacing: .02em; text-transform: none; }
    input, select, textarea, button { width: 100%; min-height: 48px; padding: 12px 14px; border: 1px solid #ffffff44; border-radius: 6px; font: inherit; }
    input, select, textarea { color: var(--ink); background: #081b1caa; caret-color: var(--amber); }
    input::placeholder, textarea::placeholder { color: #bda88e; opacity: 1; }
    input:focus, select:focus, textarea:focus { border-color: var(--amber); outline: 0; box-shadow: 0 0 0 3px rgba(230,166,83,.14); }
    button { margin-top: 12px; color: #2b251f; background: var(--amber); font-weight: 800; cursor: pointer; }
    .join-card button {
      min-height: 52px; margin-top: 14px; display: flex; align-items: center; justify-content: space-between; padding-inline: 18px; border: 0;
      color: #fff8ec; background: #a83d34; transition: transform .18s, background .18s, opacity .18s;
    }
    .join-card button:hover { background: #b8463b; transform: translateY(-1px); }
    .join-card button:disabled { cursor: wait; opacity: .68; transform: none; }
    .join-card button svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .join-card button.is-loading svg { animation: joining .9s cubic-bezier(.16,1,.3,1) infinite alternate; }
    .join-note { display: block; margin-top: 11px; color: #c6af95; font-size: 11px; line-height: 1.45; }
    .secondary { color: var(--ink); background: var(--terra); }
    [hidden] { display: none !important; }
    #room { grid-column: 1 / -1; }
    #room > .card:first-child { margin-top: 36px; }
    .queue li, .setlist li { margin: .6em 0; }
    .lyrics { white-space: pre-wrap; font: italic 18px/1.6 Georgia, serif; }
    .song-lyrics { max-height: 210px; overflow: auto; text-align: center; font: italic 18px/1.55 Georgia, serif; }
    .song-line { display: block; color: #fff8ec; }
    .song-line small { display: block; color: var(--muted); }
    .song-line.cue { margin: .8em 0; color: var(--amber); font: 800 10px sans-serif; text-transform: uppercase; }
    .player { position: sticky; bottom: 12px; }
    .player audio { width: 100%; }
    @keyframes joining { to { transform: translateX(5px); opacity: .62; } }
    @media (max-width: 760px) {
      main { width: min(560px, calc(100% - 24px)); padding: 72px 0 96px; grid-template-columns: 1fr; align-content: start; gap: 30px; }
      .room-intro { margin-inline: auto; text-align: center; }
      .room-intro h1 { margin-inline: auto; font-size: clamp(48px, 14vw, 70px); }
      .invitation { margin: 18px auto 0; font-size: 18px; }
      .room-meta { justify-content: center; margin-top: 22px; flex-wrap: wrap; }
      .join-card { padding: 22px; }
      input, select, textarea { font-size: 16px; }
    }
    @media (max-width: 360px) { main { width: calc(100% - 16px); padding-top: 44px; } .card { margin: 10px 0; padding: 16px; } }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; animation: none !important; } }
  </style>
</head>
<body>
  ${COURTYARD_SCENE}
  <main>
    <header class="room-intro">
      <h1>Come sit in the courtyard</h1>
      <p class="invitation">Someone has opened their mehfil and saved you a place.</p>
      <div class="room-meta"><span>Room <strong>${escapeHtml(roomId)}</strong></span><p id="status" class="status" aria-live="polite">Ready to join</p></div>
    </header>

    <form id="join-panel" class="join-card">
      <h2>Take your seat</h2>
      <p class="join-copy">No account or key needed. Add a name so the host knows who joined.</p>
      <label for="name">Your name <span>(optional)</span></label>
      <input id="name" maxlength="40" autocomplete="nickname" placeholder="What should we call you?">
      <button id="join" type="submit" aria-busy="false"><span id="join-label">Join the mehfil</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M14 7l5 5-5 5"/></svg></button>
      <small class="join-note">Your first tap also prepares this browser for shared audio.</small>
    </form>

    <section id="room" hidden>
      <section class="card">
        <p><strong id="listeners">0 listeners</strong> · <span id="host">Host away</span></p>
        <form id="request">
          <label for="idea">What should the song be about?</label>
          <textarea id="idea" maxlength="200" required></textarea>
          <label for="vibe">Vibe</label>
          <input id="vibe" maxlength="120">
          <label for="language">Language</label>
          <input id="language" maxlength="40">
          <button>Request a song</button>
        </form>
      </section>

      <section class="card">
        <h2>Request queue</h2>
        <ol id="queue" class="queue"></ol>
        <p id="recording"></p>
        <button id="peek" class="secondary" type="button" hidden>Don't click me</button>
        <div id="lyrics" class="lyrics" hidden></div>
      </section>

      <section id="player" class="card player" hidden>
        <h2 id="song-title"></h2>
        <p id="song-language"></p>
        <div id="song-lyrics" class="song-lyrics" aria-live="polite"></div>
        <audio id="audio" preload="metadata" controls></audio>
        <button id="play" type="button">Tap to hear the mehfil</button>
        <p id="play-error" role="alert"></p>
      </section>

      <section class="card">
        <h2>Setlist</h2>
        <ol id="setlist" class="setlist"></ol>
      </section>
    </section>
  </main>
  <script nonce="${nonce}">${client}</script>
</body>
</html>`;
}
