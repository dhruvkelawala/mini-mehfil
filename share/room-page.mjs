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
    :root {
      --ink: #f9edda; --muted: #ddcbb8; --night: #142e2d; --amber: #e6a653;
      --terracotta: #9f4939; --shadow: 0 26px 70px rgba(7,22,20,.38);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      min-height: 100svh; overflow-x: hidden; color: var(--ink); background: var(--night);
      font-family: "Avenir Next", "Gill Sans", sans-serif;
    }
    button, input, select, textarea { font: inherit; }
    button, input, select, textarea, a { -webkit-tap-highlight-color: transparent; }
    ::selection { color: #fff6e6; background: rgba(230,166,83,.4); }
    :focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
    input, textarea { caret-color: var(--amber); }
    [hidden] { display: none !important; }

    .scene, .scene svg, .grain { position: fixed; inset: 0; width: 100%; height: 100%; }
    .scene { z-index: -3; transition: transform 1.1s cubic-bezier(.16,1,.3,1); }
    .scene svg { object-fit: cover; transform: scale(1.015); animation: settle 1.4s cubic-bezier(.2,.75,.2,1) both; }
    .scene::after {
      content: ""; position: absolute; inset: 0;
      background: linear-gradient(90deg, rgba(8,25,24,.55), transparent 42%, rgba(8,25,24,.28)), linear-gradient(0deg, rgba(6,18,17,.5), transparent 45%);
    }
    .grain {
      z-index: -2; opacity: .13; pointer-events: none; mix-blend-mode: soft-light;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.9'/%3E%3C/svg%3E");
    }

    .topbar {
      height: 70px; padding: 0 28px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
      font-size: 13px; letter-spacing: .03em; text-shadow: 0 1px 15px rgba(0,0,0,.45); animation: fade-down .7s .1s both;
    }
    .topbar-room { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .09em; }
    .topbar-room strong { color: var(--ink); font-variant-numeric: tabular-nums; letter-spacing: .13em; }
    .live { display: flex; align-items: center; gap: 8px; text-transform: uppercase; font-size: 11px; letter-spacing: .16em; }
    .live i { width: 8px; height: 8px; display: block; border-radius: 50%; background: #4ddc8a; box-shadow: 0 0 14px #4ddc8a; animation: pulse 2.2s infinite; }
    .listener-label { justify-self: end; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .09em; }

    .room-layout {
      width: min(1180px, calc(100% - 44px)); margin: 16px auto 145px;
      display: grid; grid-template-columns: 1fr 460px; gap: 72px; align-items: center;
    }
    .identity {
      min-width: 0; text-align: center; align-self: center; transform: translateY(-22px);
      text-shadow: 0 5px 24px rgba(26,25,18,.32); animation: rise .9s .15s both;
    }
    .identity h1 {
      margin: 0; font-family: "Noto Serif Devanagari", "Kohinoor Devanagari", serif;
      font-size: clamp(88px, 11vw, 172px); line-height: 1.04; letter-spacing: -.01em; font-weight: 800;
      filter: drop-shadow(0 7px 0 rgba(110,32,29,.22));
    }
    .mini {
      display: block; margin-bottom: 1.15em; color: var(--amber); font-family: "Iowan Old Style", Georgia, serif;
      font-style: italic; font-weight: 600; font-size: .23em; line-height: 1.2; letter-spacing: .04em; text-indent: .06em;
    }
    .tagline { margin: 10px auto 0; max-width: 34ch; font: italic 17px/1.5 "Iowan Old Style", Georgia, serif; }
    .room-meta { margin-top: 18px; color: var(--muted); font-size: 11px; }
    .status { min-height: 1.5em; margin: 0; }
    .status::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: var(--amber); box-shadow: 0 2px 10px rgba(230,166,83,.5); }

    .composer {
      position: relative; min-width: 0; padding: 25px 26px 24px; border: 1px solid rgba(249,237,218,.16); border-radius: 9px;
      background: linear-gradient(160deg, rgba(15,38,37,.68), rgba(56,28,23,.62));
      box-shadow: var(--shadow), inset 0 1px rgba(255,255,255,.09); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
      transform: rotate(.15deg); animation: rise .9s .28s both;
    }
    .composer::before { content: ""; position: absolute; inset: 6px; border: 1px solid rgba(230,166,83,.14); border-radius: 5px; pointer-events: none; }
    .composer-head { min-width: 0; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-bottom: 15px; border-bottom: 1px solid rgba(249,237,218,.14); }
    h2 { margin: 0; font: 700 30px/1 "Iowan Old Style", Georgia, serif; letter-spacing: -.03em; }
    .room-chip { padding: 5px 9px; border: 1px solid rgba(249,237,218,.24); border-radius: 20px; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .06em; }
    .composer-copy { margin: 15px 0 2px; color: #cbb59d; font-size: 11px; line-height: 1.55; }
    .field { display: block; margin-top: 17px; }
    .field > span { display: flex; justify-content: space-between; margin-bottom: 6px; color: #dfc39a; font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .field em { color: #b99f83; font-style: normal; font-weight: 600; letter-spacing: .04em; text-transform: lowercase; }
    .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
    input, select, textarea {
      width: 100%; min-height: 43px; padding: 10px 12px; border: 1px solid rgba(249,237,218,.2); border-radius: 4px; outline: 0;
      color: var(--ink); background: rgba(8,24,23,.45); box-shadow: inset 0 1px 3px rgba(0,0,0,.2);
      transition: border-color .2s, background .2s, box-shadow .2s;
    }
    select {
      padding-right: 34px; cursor: pointer; appearance: none;
      background-image: linear-gradient(45deg, transparent 50%, var(--amber) 50%), linear-gradient(135deg, var(--amber) 50%, transparent 50%);
      background-position: calc(100% - 17px) 19px, calc(100% - 12px) 19px; background-size: 5px 5px; background-repeat: no-repeat;
    }
    select option { color: #2f2720; background: #f2e3c2; }
    textarea { height: 88px; resize: vertical; line-height: 1.45; }
    input:focus, select:focus, textarea:focus { border-color: var(--amber); background: rgba(8,24,23,.68); box-shadow: 0 0 0 3px rgba(230,166,83,.14); }
    input::placeholder, textarea::placeholder { color: #b3a08a; opacity: 1; }
    .generate {
      width: 100%; height: 49px; margin-top: 18px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between;
      border: 0; border-radius: 3px; color: #fff8ec; background: #a83d34; box-shadow: 0 5px 0 #723029, 0 12px 24px rgba(112,43,34,.2);
      cursor: pointer; font-weight: 750; transition: transform .15s, background .15s, box-shadow .15s, opacity .15s;
    }
    .generate:hover { background: #b8463b; transform: translateY(-1px); box-shadow: 0 6px 0 #723029, 0 14px 25px rgba(112,43,34,.24); }
    .generate:active { transform: translateY(4px); box-shadow: 0 1px 0 #723029; }
    .generate:disabled { cursor: wait; opacity: .65; transform: none; }
    .generate svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .generate.is-loading svg { animation: joining .9s cubic-bezier(.16,1,.3,1) infinite alternate; }
    .join-note { display: block; margin-top: 12px; color: #b39a7f; font-size: 10px; text-align: center; }

    #room { display: contents; }
    .room-shelves {
      grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 40px;
      padding-top: 8px; animation: rise .65s .12s both;
    }
    .shelf { min-width: 0; padding: 22px 4px 0; border-top: 1px solid rgba(249,237,218,.24); }
    .shelf h2 { font-size: 24px; }
    .shelf ol { min-height: 34px; margin: 15px 0 0; padding-left: 22px; color: var(--muted); font-size: 12px; line-height: 1.7; }
    .shelf a { color: var(--amber); text-underline-offset: 3px; }
    .recording { min-height: 1.5em; color: #9ed2b8; font-size: 11px; }
    .secondary { width: auto; min-height: 40px; padding: 8px 12px; border: 1px solid rgba(249,237,218,.3); border-radius: 5px; color: var(--ink); background: rgba(122,54,45,.75); cursor: pointer; }
    .lyrics { margin-top: 16px; white-space: pre-wrap; color: var(--muted); font: italic 16px/1.6 "Iowan Old Style", Georgia, serif; }

    .player-shell {
      position: fixed; z-index: 5; bottom: 25px; left: 50%; width: min(680px, calc(100% - 32px)); min-height: 88px;
      display: grid; grid-template-columns: 68px minmax(0,1fr) 52px; align-items: center; gap: 12px; padding: 10px 16px 10px 10px;
      border: 1px solid rgba(255,255,255,.2); border-radius: 52px; background: rgba(122,54,45,.93);
      box-shadow: 0 20px 55px rgba(8,19,18,.42), inset 0 1px rgba(255,255,255,.15); backdrop-filter: blur(12px);
      transform: translateX(-50%); animation: player-up .85s both;
    }
    .record { width: 68px; height: 68px; display: grid; place-items: center; border-radius: 50%; background: repeating-radial-gradient(circle, #202322 0 3px, #101313 4px 6px); box-shadow: 0 4px 14px rgba(0,0,0,.35); }
    .record::after { content: "M"; width: 29px; height: 29px; display: grid; place-items: center; border-radius: 50%; background: var(--amber); color: #67362e; font: 800 14px Georgia, serif; }
    .player-track { min-width: 0; }
    .player-track h2, .player-track p { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .player-track h2 { font-size: 16px; }
    .player-track p { margin: 3px 0 0; color: var(--muted); font-size: 10px; }
    .song-lyrics { max-height: 0; overflow: hidden; }
    .play-button { width: 49px; height: 49px; display: grid; place-items: center; border: 0; border-radius: 50%; color: #29322e; background: #fffaf0; cursor: pointer; font-size: 11px; font-weight: 800; }
    .player-shell audio { display: none; }
    .play-error { grid-column: 2 / -1; margin: -8px 0 2px; color: #ffe0cb; font-size: 10px; }
    .song-line { display: block; }
    .song-line small { display: block; color: var(--muted); }
    .song-line.cue { color: var(--amber); font: 800 10px sans-serif; text-transform: uppercase; }

    @keyframes joining { to { transform: translateX(5px); opacity: .62; } }
    @keyframes settle { from { opacity: 0; transform: scale(1.08); } to { opacity: 1; transform: scale(1.015); } }
    @keyframes fade-down { from { opacity: 0; transform: translateY(-10px); } }
    @keyframes rise { from { opacity: 0; transform: translateY(25px); } }
    @keyframes player-up { from { opacity: 0; transform: translate(-50%,30px); } }
    @keyframes pulse { 50% { opacity: .45; transform: scale(.85); } }
    @media (max-width: 900px) {
      .room-layout { grid-template-columns: minmax(0,1fr); gap: 16px; margin-top: 0; }
      .identity { transform: none; }
      .identity h1 { font-size: clamp(76px, 22vw, 132px); }
      .tagline { margin-top: 6px; }
      .composer { width: min(520px,100%); margin: 0 auto; }
      .room-shelves { width: min(720px,100%); margin: 28px auto 0; gap: 28px; }
    }
    @media (max-width: 560px) {
      .topbar { height: 58px; padding: 0 16px; grid-template-columns: 1fr 1fr; }
      .live { position: absolute; left: 50%; transform: translateX(-50%); }
      .listener-label { display: none; }
      .room-layout { width: calc(100% - 24px); margin-bottom: 112px; }
      .identity { margin-top: 5px; }
      .identity h1 { font-size: clamp(68px,19vw,112px); }
      .tagline { font-size: 14px; }
      .room-meta { margin-top: 12px; }
      .composer { width: 100%; max-width: 100%; justify-self: stretch; padding: 20px 18px; }
      .composer h2 { font-size: 26px; }
      .room-chip { display: none; }
      .field-row, .room-shelves { grid-template-columns: 1fr; }
      input, select, textarea { font-size: 16px; }
      .room-shelves { gap: 20px; }
      .player-shell { bottom: 12px; min-height: 72px; grid-template-columns: 50px minmax(0,1fr) 42px; padding: 8px 12px 8px 8px; }
      .record { width: 50px; height: 50px; }
      .record::after { width: 22px; height: 22px; font-size: 11px; }
      .play-button { width: 41px; height: 41px; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }
  </style>
</head>
<body>
  ${COURTYARD_SCENE}
  <div class="grain" aria-hidden="true"></div>
  <header class="topbar">
    <div class="topbar-room">Room <strong>${escapeHtml(roomId)}</strong></div>
    <div class="live"><i></i><span>music-3.0</span></div>
    <div class="listener-label">Listener</div>
  </header>

  <main class="room-layout">
    <section class="identity" aria-labelledby="brand-title">
      <h1 id="brand-title" aria-label="Mini Mehfil"><span class="mini" aria-hidden="true">Mini</span>महफ़िल</h1>
      <p class="tagline">A private song room. Request the next tune, then listen together.</p>
      <div class="room-meta"><p id="status" class="status" aria-live="polite">Ready to join</p></div>
    </section>

    <form id="join-panel" class="composer">
      <div class="composer-head"><h2>Join the mehfil</h2><span class="room-chip">Room ${escapeHtml(roomId)}</span></div>
      <p class="composer-copy">No account or key needed. Add a name so the host knows who joined.</p>
      <label class="field" for="name"><span>Your name <em>optional</em></span></label>
      <input id="name" maxlength="40" autocomplete="nickname" placeholder="What should we call you?">
      <button id="join" class="generate" type="submit" aria-busy="false"><span id="join-label">Join the mehfil</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M14 7l5 5-5 5"/></svg></button>
      <small class="join-note">Your first tap also prepares this browser for shared audio.</small>
    </form>

    <section id="room" hidden>
      <form id="request" class="composer request-composer">
        <div class="composer-head"><h2>Request a song</h2><span class="room-chip"><strong id="listeners">0 listeners</strong> · <span id="host">Host away</span></span></div>
        <label class="field" for="idea"><span>What's the song about?</span></label>
        <textarea id="idea" maxlength="200" required placeholder="A late-night drive home, monsoon chai…"></textarea>
        <div class="field-row">
          <label class="field" for="vibe"><span>Vibe <em>optional</em></span><input id="vibe" maxlength="120" placeholder="warm, acoustic"></label>
          <label class="field" for="language"><span>Language</span><select id="language">
            <option value="auto" selected>Auto-detect</option>
            <option value="Gujarati">Gujarati</option>
            <option value="Hindi">Hindi</option>
            <option value="Punjabi">Punjabi</option>
            <option value="Tamil">Tamil</option>
            <option value="Bengali">Bengali</option>
            <option value="Marathi">Marathi</option>
            <option value="Urdu">Urdu</option>
            <option value="English">English</option>
            <option value="Spanish">Spanish</option>
            <option value="French">French</option>
            <option value="Arabic">Arabic</option>
            <option value="Japanese">Japanese</option>
            <option value="Korean">Korean</option>
          </select></label>
        </div>
        <button class="generate"><span>Request a song</span><span aria-hidden="true">→</span></button>
      </form>

      <section class="room-shelves" aria-label="Room activity">
        <section class="shelf">
          <h2>Request queue</h2>
          <ol id="queue" class="queue"></ol>
          <p id="recording" class="recording"></p>
          <button id="peek" class="secondary" type="button" hidden>Reveal lyrics</button>
          <div id="lyrics" class="lyrics" hidden></div>
        </section>
        <section class="shelf">
          <h2>Setlist</h2>
          <ol id="setlist" class="setlist"></ol>
        </section>
      </section>

      <section id="player" class="player-shell" hidden>
        <div class="record" aria-hidden="true"></div>
        <div class="player-track"><h2 id="song-title"></h2><p id="song-language"></p><div id="song-lyrics" class="song-lyrics" aria-live="polite"></div></div>
        <audio id="audio" preload="metadata"></audio>
        <button id="play" class="play-button" type="button">Play</button>
        <p id="play-error" class="play-error" role="alert"></p>
      </section>
    </section>
  </main>
  <script nonce="${nonce}">${client}</script>
</body>
</html>`;
}
