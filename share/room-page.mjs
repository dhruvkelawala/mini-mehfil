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
  const client = `(${installRoomClient.toString()})(${scriptJson({ roomId })});`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#1f4238">
  <title>Room ${escapeHtml(roomId)} · Mini Mehfil</title>
  <style nonce="${nonce}">
    :root {
      --ink: #f9edda;
      --muted: #ddcbb8;
      --night: #142e2d;
      --amber: #e6a653;
      --terra: #7a362d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100svh;
      color: var(--ink);
      background: var(--night);
      font-family: "Avenir Next", sans-serif;
    }
    .scene,
    .scene svg {
      position: fixed;
      inset: 0;
      z-index: -2;
      width: 100%;
      height: 100%;
    }
    .scene::after {
      content: "";
      position: absolute;
      inset: 0;
      background: rgba(7, 25, 24, 0.58);
    }
    .scene.is-performing { filter: saturate(1.1); }
    main {
      width: min(760px, calc(100% - 28px));
      margin: auto;
      padding: 32px 0 80px;
    }
    .card {
      margin: 16px 0;
      padding: 22px;
      border: 1px solid #ffffff35;
      border-radius: 22px;
      background: #142e2de8;
      backdrop-filter: blur(12px);
    }
    h1,
    h2 { font-family: Georgia, serif; }
    label {
      display: block;
      margin: 12px 0 5px;
    }
    input,
    select,
    textarea,
    button {
      width: 100%;
      padding: 12px;
      border: 1px solid #ffffff44;
      border-radius: 12px;
      font: inherit;
    }
    input,
    select,
    textarea {
      color: var(--ink);
      background: #081b1caa;
    }
    button {
      margin-top: 12px;
      color: #2b251f;
      background: var(--amber);
      font-weight: 800;
      cursor: pointer;
    }
    .secondary {
      color: var(--ink);
      background: var(--terra);
    }
    [hidden] { display: none !important; }
    .status {
      min-height: 1.5em;
      color: var(--muted);
    }
    .queue li,
    .setlist li { margin: 0.6em 0; }
    .lyrics {
      white-space: pre-wrap;
      font: italic 18px/1.6 Georgia, serif;
    }
    .song-lyrics {
      max-height: 210px;
      overflow: auto;
      text-align: center;
      font: italic 18px/1.55 Georgia, serif;
    }
    .song-line {
      display: block;
      color: #fff8ec;
    }
    .song-line small {
      display: block;
      color: var(--muted);
    }
    .song-line.cue {
      margin: 0.8em 0;
      color: var(--amber);
      font: 800 10px sans-serif;
      text-transform: uppercase;
    }
    .player {
      position: sticky;
      bottom: 12px;
    }
    .player audio { width: 100%; }
    @media (max-width: 360px) {
      main { width: calc(100% - 16px); }
      .card {
        margin: 10px 0;
        padding: 16px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        scroll-behavior: auto !important;
        animation: none !important;
      }
    }
  </style>
</head>
<body>
  ${COURTYARD_SCENE}
  <main>
    <header>
      <small>LIVE MEHFIL · ${escapeHtml(roomId)}</small>
      <h1>Come sit in the courtyard</h1>
      <p id="status" class="status" aria-live="polite">Ready to join.</p>
    </header>

    <section id="join-panel" class="card">
      <h2>Join this mehfil</h2>
      <label for="name">Your name (optional)</label>
      <input id="name" maxlength="40" autocomplete="nickname">
      <button id="join" type="button">Join the mehfil 🔊</button>
    </section>

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
