import { COURTYARD_SCENE } from '../src/worker/courtyard.ts';
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
    .identity.has-song { transform: translateY(-8px); }
    .identity.has-song h1 { font-size: clamp(66px, 7vw, 108px); }
    .identity.has-song .mini { margin-bottom: .65em; }
    .lyric-stage { width: min(620px,100%); min-height: 190px; margin: 25px auto 0; display: grid; align-content: center; }
    .lyric-stage h2 { color: #e6a653; font-size: 20px; letter-spacing: -.01em; }
    .lyric-cue { min-height: 1.5em; margin: 18px 0 5px; color: #dfc39a; font-size: 10px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
    .lyric-primary { margin: 0; color: #fff8ec; font: 700 clamp(27px,3.3vw,44px)/1.22 "Iowan Old Style", Georgia, serif; text-wrap: balance; text-shadow: 0 5px 26px rgba(0,0,0,.45); }
    .lyric-secondary { min-height: 1.5em; margin: 10px 0 0; color: #dfcbb5; font: italic 15px/1.45 "Iowan Old Style", Georgia, serif; text-wrap: balance; }
    .lyric-primary.is-new, .lyric-secondary.is-new { animation: lyric-focus .48s cubic-bezier(.16,1,.3,1) both; }

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
    body:has(#room:not([hidden])) .room-layout {
      width: min(960px, calc(100% - 44px)); grid-template-columns: minmax(0,1fr); margin-top: 0;
    }
    body:has(#room:not([hidden])) .identity { transform: none; }
    .identity.has-song .tagline { display: none; }
    .room-menu {
      position: fixed; z-index: 7; top: 84px; right: max(22px, env(safe-area-inset-right));
      width: min(390px, calc(100vw - 32px)); color: var(--ink);
    }
    .room-menu:not([open]) { width: auto; }
    .room-menu > summary {
      min-height: 44px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 14px;
      border: 1px solid rgba(249,237,218,.28); border-radius: 12px; background: rgba(16,42,40,.94);
      box-shadow: 0 10px 30px rgba(7,22,20,.28); cursor: pointer; list-style: none;
    }
    .room-menu > summary::-webkit-details-marker, .activity > summary::-webkit-details-marker { display: none; }
    .room-menu > summary::after { content: "+"; color: var(--amber); font: 600 22px/1 Georgia, serif; }
    .room-menu[open] > summary { border-radius: 12px 12px 0 0; border-bottom-color: transparent; box-shadow: none; }
    .room-menu[open] > summary::after { content: "−"; }
    .room-menu-label { font-weight: 750; }
    .room-menu-meta { color: var(--muted); font-size: 10px; white-space: nowrap; }
    .room-menu-body {
      max-height: calc(100svh - 150px); overflow-y: auto; padding: 4px 18px 18px;
      border: 1px solid rgba(249,237,218,.28); border-top: 0; border-radius: 0 0 12px 12px;
      background: rgba(16,42,40,.97); box-shadow: var(--shadow); scrollbar-color: var(--amber) rgba(249,237,218,.08);
    }
    .request-form textarea { height: 82px; }
    .request-form .field { margin-top: 14px; }
    .request-form .generate { margin-top: 16px; }
    .activity { margin-top: 20px; padding-top: 14px; border-top: 1px solid rgba(249,237,218,.16); }
    .activity > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; list-style: none; }
    .activity > summary::after { content: "+"; color: var(--amber); }
    .activity[open] > summary::after { content: "−"; }
    .activity > summary span { font-weight: 700; }
    .activity > summary small { margin-left: auto; color: var(--muted); font-size: 10px; }
    .room-shelves {
      display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding-top: 6px;
    }
    .shelf { min-width: 0; padding: 16px 0 0; }
    .shelf h2 { font: 700 11px/1.2 "Avenir Next", "Gill Sans", sans-serif; letter-spacing: .1em; text-transform: uppercase; }
    .shelf ol { min-height: 24px; margin: 9px 0 0; padding-left: 18px; color: var(--muted); font-size: 11px; line-height: 1.6; }
    .shelf a { color: var(--amber); text-underline-offset: 3px; }
    .recording { min-height: 1.5em; color: #9ed2b8; font-size: 11px; }
    .secondary { width: auto; min-height: 40px; padding: 8px 12px; border: 1px solid rgba(249,237,218,.3); border-radius: 5px; color: var(--ink); background: rgba(122,54,45,.75); cursor: pointer; }
    .lyrics { margin-top: 12px; white-space: pre-wrap; color: var(--muted); font: italic 14px/1.55 "Iowan Old Style", Georgia, serif; }

    .player-shell {
      position: fixed; z-index: 5; bottom: 25px; left: 50%; width: min(720px, calc(100% - 32px)); min-height: 104px;
      display: grid; grid-template-columns: 68px minmax(0,1fr) 42px; align-items: center; gap: 12px; padding: 10px 14px 10px 10px;
      border: 1px solid rgba(255,255,255,.2); border-radius: 34px; background: rgba(122,54,45,.96);
      box-shadow: 0 20px 55px rgba(8,19,18,.42), inset 0 1px rgba(255,255,255,.15); backdrop-filter: blur(12px);
      transform: translateX(-50%); animation: player-up .85s both;
    }
    .record { width: 68px; height: 68px; display: grid; place-items: center; border-radius: 50%; background: repeating-radial-gradient(circle, #202322 0 3px, #101313 4px 6px); box-shadow: 0 4px 14px rgba(0,0,0,.35); }
    .record::after { content: "M"; width: 29px; height: 29px; display: grid; place-items: center; border-radius: 50%; background: var(--amber); color: #67362e; font: 800 14px Georgia, serif; }
    .player-shell.is-playing .record { animation: spin 4s linear infinite; }
    .player-track { min-width: 0; }
    .player-track h2, .player-track p { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .player-track h2 { font-size: 16px; }
    .player-track p { margin: 3px 0 0; color: var(--muted); font-size: 10px; }
    .host-playback { display: flex; align-items: center; gap: 6px; color: #f1d8bd !important; }
    .host-playback svg { width: 13px; height: 13px; fill: none; stroke: #e6a653; stroke-width: 1.8; stroke-linecap: round; }
    .timeline { display: grid; grid-template-columns: minmax(80px,1fr) auto; align-items: center; gap: 9px; margin-top: 5px; }
    #listener-seek { width: 100%; height: 3px; min-height: 3px; padding: 0; border: 0; border-radius: 2px; appearance: none; background: rgba(255,255,255,.28); box-shadow: none; }
    #listener-seek::-webkit-slider-thumb { width: 8px; height: 8px; border: 0; border-radius: 50%; appearance: none; background: #fffaf0; }
    #listener-seek::-moz-range-thumb { width: 8px; height: 8px; border: 0; border-radius: 50%; background: #fffaf0; }
    #listener-seek:disabled { cursor: not-allowed; opacity: .78; }
    #timecode { color: #ead0b5; font-size: 9px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .listener-play { width: 40px; height: 40px; display: grid; place-items: center; border: 1px solid rgba(255,255,255,.28); border-radius: 50%; color: #fff8ec; background: rgba(41,50,46,.34); }
    .listener-play:disabled { cursor: not-allowed; opacity: .58; }
    .listener-play svg { width: 17px; height: 17px; fill: currentColor; }
    .listener-play .pause-icon { display: none; }
    .player-shell.is-playing .listener-play .play-icon { display: none; }
    .player-shell.is-playing .listener-play .pause-icon { display: block; }
    .enable-audio { grid-column: 2; justify-self: start; min-height: 34px; padding: 7px 11px; border: 1px solid rgba(255,255,255,.28); border-radius: 18px; color: #fff8ec; background: rgba(41,50,46,.6); cursor: pointer; font-size: 10px; font-weight: 800; }
    .player-shell audio { display: none; }
    .play-error { grid-column: 2 / -1; margin: -8px 0 2px; color: #ffe0cb; font-size: 10px; }

    @keyframes joining { to { transform: translateX(5px); opacity: .62; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes lyric-focus { from { opacity: .2; filter: blur(4px); transform: translateY(8px); } }
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
      .identity.has-song { transform: none; }
      .identity.has-song h1 { font-size: clamp(64px,13vw,92px); }
      .composer { width: min(520px,100%); margin: 0 auto; }
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
      .room-menu { top: auto; right: 12px; bottom: 108px; left: 12px; width: auto; }
      .room-menu:not([open]) { left: auto; }
      .room-menu-body { max-height: calc(100svh - 190px); }
      .room-shelves { gap: 2px; }
      .lyric-stage { min-height: 150px; margin-top: 18px; padding-inline: 8px; }
      .lyric-primary { font-size: clamp(25px,7.5vw,36px); }
      .lyric-secondary { font-size: 14px; }
      .player-shell { bottom: 12px; min-height: 84px; grid-template-columns: 50px minmax(0,1fr) 36px; gap: 9px; padding: 8px; border-radius: 28px; }
      .record { width: 50px; height: 50px; }
      .record::after { width: 22px; height: 22px; font-size: 11px; }
      .listener-play { width: 34px; height: 34px; }
      #timecode { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
      .player-shell.is-playing .record { animation: none; }
    }
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
      <section id="lyric-stage" class="lyric-stage" aria-labelledby="lyric-title" hidden>
        <h2 id="lyric-title"></h2>
        <p id="lyric-cue" class="lyric-cue"></p>
        <p id="lyric-primary" class="lyric-primary" aria-live="polite"></p>
        <p id="lyric-secondary" class="lyric-secondary"></p>
      </section>
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
      <details id="room-menu" class="room-menu">
        <summary>
          <span class="room-menu-label">Request a song</span>
          <small class="room-menu-meta"><strong id="listeners">0 listeners</strong> · <span id="host">Host away</span></small>
        </summary>
        <div class="room-menu-body">
          <form id="request" class="request-form">
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
            <button class="generate"><span>Send request</span><span aria-hidden="true">→</span></button>
          </form>

          <details class="activity">
            <summary><span>Room activity</span><small id="room-activity-count">Queue &amp; setlist</small></summary>
            <div class="room-shelves">
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
            </div>
          </details>
        </div>
      </details>

      <section id="player" class="player-shell" aria-label="Host-controlled song player">
        <div class="record" aria-hidden="true"></div>
        <div class="player-track">
          <h2 id="song-title">Waiting for the first song</h2>
          <p id="song-language">The host controls playback</p>
          <p class="host-playback"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10v4M12 8v8M16 10v4"/></svg><span id="playback-state">Waiting for the host</span></p>
          <div class="timeline"><input id="listener-seek" type="range" min="0" max="100" value="0" aria-label="Playback position, controlled by the host" disabled><span id="timecode">0:00 / 0:00</span></div>
        </div>
        <button id="listener-play" class="listener-play" type="button" aria-label="Playback is controlled by the host" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path class="play-icon" d="M8 5l11 7-11 7z"/><path class="pause-icon" d="M7 5h4v14H7zM14 5h4v14h-4z"/></svg></button>
        <audio id="audio" preload="metadata"></audio>
        <button id="enable-audio" class="enable-audio" type="button" hidden>Enable sound</button>
        <p id="play-error" class="play-error" role="alert"></p>
      </section>
    </section>
  </main>
  <script nonce="${nonce}">${client}</script>
</body>
</html>`;
}
