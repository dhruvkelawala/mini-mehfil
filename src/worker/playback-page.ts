import {
  buildSectionTimeline,
  normalizeLyricTiming,
  parseLyricSheet,
  type LyricTiming,
} from '../lyrics/lyric-sync.ts';
import { buildLinePacing } from '../lyrics/line-pacing.ts';
import {
  storyCardHost,
  storyFileName,
  storyStanza,
  storyStanzaSection,
} from '../shared/story-card.ts';
import { FOLK_MODERN_BACKGROUND_PATH, FOLK_MODERN_SCENE } from './courtyard.ts';
import { STORY_CARD_SCRIPT } from './story-card-script.generated.ts';

const EXTERNAL_LINK_ICON =
  '<svg class="topbar-link-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 16 8M9 8h7v7"/></svg>';
const REPLAY_ICON =
  '<svg class="replay-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8V4m0 0h4M5 4l3.1 3.1a7 7 0 1 1-1.4 7.2"/></svg>';
const PLAY_ICON =
  '<svg class="player-icon play-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 6.5v11l9-5.5-9-5.5Z"/></svg>';
const PAUSE_ICON =
  '<svg class="player-icon pause-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7v10M16 7v10"/></svg>';
const SHARE_ICON =
  '<svg class="player-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8.5 12 5l3 3.5M12 5v10M7 11.5H5.5A1.5 1.5 0 0 0 4 13v4.5A1.5 1.5 0 0 0 5.5 19h13a1.5 1.5 0 0 0 1.5-1.5V13a1.5 1.5 0 0 0-1.5-1.5H17"/></svg>';
const DOWNLOAD_ICON =
  '<svg class="player-icon download-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v10M8.5 11.5 12 15l3.5-3.5M5 19h14"/></svg>';
const STORY_ICON =
  '<svg class="player-icon story-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 3.6h6.8A2.6 2.6 0 0 1 18 6.2v11.6a2.6 2.6 0 0 1-2.6 2.6H8.6A2.6 2.6 0 0 1 6 17.8V6.2a2.6 2.6 0 0 1 2.6-2.6Z"/><path d="m12 8.4 1.05 2.55L15.6 12l-2.55 1.05L12 15.6l-1.05-2.55L8.4 12l2.55-1.05L12 8.4Z"/></svg>';

export interface PlaybackSong {
  title: string;
  language: string;
  nativeScriptName: string;
  isLatinScript: boolean;
  lyricsNative: string;
  lyricsRoman: string;
  /**
   * Section timing for this exact recording, or `null`/absent. Shares stored
   * before section analysis existed have no field at all, so every reader must
   * re-normalize rather than trust the shape.
   */
  lyricTiming?: LyricTiming | null;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function scriptJson(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

export function playbackPage(
  id: string,
  song: PlaybackSong,
  nonce: string,
  origin: string,
  previewImageUrl: string,
): string {
  const label =
    song.isLatinScript || !song.nativeScriptName
      ? song.language
      : `${song.language} · ${song.nativeScriptName}`;
  // Parse and map on the server so the page ships display text and a timeline,
  // never raw provider output and never a parser the browser has to trust.
  const sheet = parseLyricSheet(song);
  const timing = normalizeLyricTiming(song.lyricTiming);
  const timeline = buildSectionTimeline(sheet.sections, timing);
  const pacing = buildLinePacing(sheet.sections, timeline);
  const safeLine = ({
    cue,
    primary,
    secondary,
  }: {
    cue: boolean;
    primary: string;
    secondary: string;
  }) => ({ cue, primary, secondary });
  const shareUrl = `${origin}/s/${id}`;
  // Every choice the story card makes is settled here, by the same functions
  // the host app calls, so both surfaces hand out the same picture.
  const card = {
    title: song.title,
    label,
    url: shareUrl,
    host: storyCardHost(shareUrl),
    fileName: storyFileName(song.title, 'jpg'),
    videoFileName: storyFileName(song.title, 'mp4'),
    sectionIndex: storyStanzaSection(sheet.sections)?.index ?? null,
    stanza: storyStanza(sheet.sections, sheet.lines),
    backgroundUrl: FOLK_MODERN_BACKGROUND_PATH,
  };
  const data = scriptJson({
    lines: sheet.lines.map(safeLine),
    sections: sheet.sections.map((section) => ({
      index: section.index,
      lines: section.lines.map(safeLine),
    })),
    timeline,
    ...(timeline ? { pacing } : {}),
    expectedDurationSeconds: timing?.durationSeconds ?? 0,
    card,
  });
  const audioUrl = `${shareUrl}/audio`;
  const description = `Listen to ${song.title} in the Mini Mehfil courtyard.`;
  const playLabel = scriptJson(`Play ${song.title}`);
  // A player card needs domain approval from X, so the page advertises a large
  // summary card, which every reader renders today. The og:audio tags stay for
  // the platforms that play audio from them.
  const imageMetadata = previewImageUrl
    ? `<meta property="og:image" content="${escapeHtml(previewImageUrl)}"><meta name="twitter:image" content="${escapeHtml(previewImageUrl)}">`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#1f4238">
<title>${escapeHtml(song.title)} · Mini Mehfil</title><meta name="description" content="${escapeHtml(description)}">
<link rel="icon" href="https://minimehfil.wtf/favicon.ico" sizes="16x16 32x32 48x48"><link rel="icon" href="https://minimehfil.wtf/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="https://minimehfil.wtf/apple-touch-icon.png">
<link rel="preload" as="image" href="${FOLK_MODERN_BACKGROUND_PATH}">
<meta property="og:site_name" content="Mini Mehfil"><meta property="og:title" content="${escapeHtml(song.title)} · Mini Mehfil"><meta property="og:type" content="music.song"><meta property="og:url" content="${escapeHtml(shareUrl)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:audio" content="${escapeHtml(audioUrl)}"><meta property="og:audio:secure_url" content="${escapeHtml(audioUrl)}"><meta property="og:audio:type" content="audio/mpeg">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@dhruv_kelawala"><meta name="twitter:title" content="${escapeHtml(song.title)} · Mini Mehfil"><meta name="twitter:description" content="${escapeHtml(description)}">${imageMetadata}
<style nonce="${nonce}">
:root{--ink:#f9edda;--muted:#ddcbb8;--night:#142e2d;--amber:#e6a653}*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{min-height:100svh;overflow:hidden;color:var(--ink);background:var(--night);font-family:"Avenir Next","Gill Sans",sans-serif}button,input{font:inherit}button,a,input{-webkit-tap-highlight-color:transparent}:focus-visible{outline:2px solid var(--amber);outline-offset:2px}.scene,.grain{position:fixed;inset:0;width:100%;height:100%}.scene{z-index:-3;background-image:url('${FOLK_MODERN_BACKGROUND_PATH}');background-position:center;background-repeat:no-repeat;background-size:cover;transform:scale(1.015);animation:settle 1.4s cubic-bezier(.2,.75,.2,1) both;transition:transform 1.1s cubic-bezier(.16,1,.3,1)}.scene:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,25,24,.55),transparent 42%,rgba(8,25,24,.28)),linear-gradient(0deg,rgba(6,18,17,.5),transparent 45%)}.grain{z-index:-2;opacity:.13;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.9'/%3E%3C/svg%3E");mix-blend-mode:soft-light}.scene.is-performing{transform:scale(1.018);filter:saturate(1.08)}.topbar{position:relative;z-index:6;height:70px;padding:0 28px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;font-size:13px;letter-spacing:.03em;text-shadow:0 1px 15px rgba(0,0,0,.45);animation:fade-down .7s .1s both}.topbar a{justify-self:end;display:inline-flex;align-items:center;gap:6px;color:var(--ink);text-decoration:none;border-bottom:1px solid transparent}.topbar a:hover{border-color:currentColor}.topbar-link-icon{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.live{display:flex;align-items:center;gap:8px;text-transform:uppercase;font-size:11px;letter-spacing:.16em}.live i{width:8px;height:8px;display:block;border-radius:50%;background:#4ddc8a;box-shadow:0 0 14px #4ddc8a;animation:pulse 2.2s infinite}.performance{position:fixed;z-index:4;inset:0;display:grid;place-items:center;padding:74px 24px 132px;overflow:hidden;background:radial-gradient(ellipse at 50% 47%,transparent 12%,rgba(5,20,19,.13) 62%,rgba(4,15,15,.46) 110%);animation:performance-in .55s ease-out both}.performance:after{content:"";position:absolute;inset:auto 0 0;height:42%;pointer-events:none;background:linear-gradient(0deg,rgba(5,17,16,.32),transparent)}.performance-content{position:relative;z-index:1;width:min(720px,100%);text-align:center;text-shadow:0 3px 20px rgba(0,0,0,.8)}.lyric-reveal{position:relative;margin:0 auto;padding:25px 34px 28px;border-block:1px solid rgba(230,166,83,.34);border-radius:2px;background:linear-gradient(90deg,transparent,rgba(7,27,25,.74) 12%,rgba(35,25,21,.72) 50%,rgba(7,27,25,.74) 88%,transparent);box-shadow:0 25px 55px rgba(4,15,14,.2);backdrop-filter:blur(9px);text-align:left}.reveal-language{display:block;margin-bottom:4px;color:#e9c27f;font-size:10px;font-weight:800;letter-spacing:.12em;text-align:center;text-transform:uppercase}.performance-timing{display:block;margin:4px 0 14px;color:#cfbda8;font-size:10px;font-style:italic;letter-spacing:.03em;text-align:center}.reveal-lines{margin:0;max-height:max(140px,min(52svh,430px,calc(100svh - 340px)));overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(230,166,83,.4) transparent;font:italic clamp(18px,2.3vw,25px)/1.55 "Iowan Old Style",Georgia,serif;text-align:center}.lyric-line{display:block;color:rgba(249,237,218,.78);transition:color .35s,text-shadow .35s,transform .35s}.lyric-line[hidden]{display:none}.lyric-line+.lyric-line{margin-top:.2em}.lyric-line:not([hidden]){animation:lyric-arrive .5s cubic-bezier(.16,1,.3,1) both}.lyric-line.lyric-cue{margin-block:.95em .4em;color:var(--amber);font:800 10px/1.2 "Avenir Next","Gill Sans",sans-serif;letter-spacing:.16em;text-transform:uppercase}.lyric-primary{display:block;color:#fff8ec}.lyric-secondary{display:block;margin-top:.1em;color:#d8c3aa;font-size:.68em;line-height:1.35}.lyric-section{display:block;padding:.25em .55em;border-radius:5px;transition:background .25s,box-shadow .25s,opacity .25s}.lyric-section+.lyric-section{margin-top:.7em}.lyric-section-current{background:rgba(230,166,83,.09);box-shadow:inset 0 0 0 1px rgba(230,166,83,.18)}.performance-replay{margin-top:22px;padding:11px 19px;display:inline-flex;align-items:center;gap:9px;border:1px solid rgba(249,237,218,.5);border-radius:24px;color:var(--ink);background:rgba(11,34,32,.68);backdrop-filter:blur(8px);cursor:pointer;font:700 15px/1.2 "Iowan Old Style",Georgia,serif}.performance-replay[hidden]{display:none}.performance-replay:hover{border-color:var(--amber);background:rgba(65,39,29,.78)}.replay-icon{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.player-shell{position:fixed;z-index:5;bottom:25px;left:50%;width:min(680px,calc(100vw - 44px));min-height:88px;transform:translateX(-50%);display:grid;grid-template-columns:72px 1fr 55px auto;align-items:center;gap:9px;padding:10px 15px 10px 10px;border:1px solid rgba(255,255,255,.2);border-radius:52px;background:rgba(122,54,45,.93);box-shadow:0 20px 55px rgba(8,19,18,.42),inset 0 1px rgba(255,255,255,.15);backdrop-filter:blur(12px);animation:player-up .85s .5s both}.record{width:68px;height:68px;display:grid;place-items:center;border-radius:50%;background:repeating-radial-gradient(circle,#202322 0 3px,#101313 4px 6px);box-shadow:0 4px 14px rgba(0,0,0,.35)}.record-label{width:29px;height:29px;display:grid;place-items:center;border-radius:50%;background:var(--amber);color:#67362e;font:800 14px Georgia,serif}.player-shell.playing .record{animation:spin 4s linear infinite}.track{min-width:0}.track strong,.track>span{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.track strong{font:600 14px/1.3 "Iowan Old Style",Georgia,serif}.track>span{margin-top:2px;color:var(--muted);font-size:10px}.timeline{display:grid;grid-template-columns:1fr auto;align-items:center;gap:9px;margin-top:9px}#seek{appearance:none;width:100%;height:3px;padding:0;border:0;border-radius:2px;background:rgba(255,255,255,.26);cursor:pointer}#seek::-webkit-slider-thumb{appearance:none;width:9px;height:9px;border-radius:50%;background:white}.timecode{color:var(--muted);font-size:9px;font-variant-numeric:tabular-nums}.play{width:49px;height:49px;display:grid;place-items:center;border:0;border-radius:50%;color:#29322e;background:#fffaf0;cursor:pointer;box-shadow:0 5px 15px rgba(0,0,0,.18)}.player-icon{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.play-icon{fill:currentColor;stroke:currentColor}.pause-icon{display:none}.player-shell.playing .play-icon{display:none}.player-shell.playing .pause-icon{display:block}.player-action,.download{width:44px;height:45px;display:grid;place-items:center;border:0;color:var(--ink);background:transparent;text-decoration:none;cursor:pointer;line-height:1}.player-action span,.download span{font-size:8px;text-transform:uppercase;letter-spacing:.08em;margin-top:-9px}.player-action:hover,.download:hover{color:white}.player-actions{display:flex;align-items:center}.story-stage{position:fixed;inset:0;z-index:9;height:100svh;display:grid;grid-template-rows:minmax(0,1fr) auto;justify-items:center;gap:14px;padding:14px 16px calc(14px + env(safe-area-inset-bottom));background:rgba(4,15,14,.96);backdrop-filter:blur(8px);animation:performance-in .35s ease-out both}.story-stage[hidden]{display:none}.story-canvas{min-height:0;max-width:100%;max-height:100%;align-self:center;border-radius:16px;box-shadow:0 22px 55px rgba(4,15,14,.6);touch-action:none;cursor:grab}.story-canvas:active{cursor:grabbing}.story-foot{display:grid;gap:11px;width:min(420px,100%)}.story-where{color:var(--muted);font-size:12px;letter-spacing:.03em;text-align:center;font-variant-numeric:tabular-nums}.story-where[hidden]{display:none}.story-lengths{display:flex;justify-content:center;gap:4px}.story-lengths[hidden]{display:none}.story-length{min-width:52px;min-height:36px;padding:0 12px;border:0;border-radius:18px;color:var(--muted);background:transparent;font:700 12px/1 "Avenir Next","Gill Sans",sans-serif;letter-spacing:.04em;cursor:pointer;font-variant-numeric:tabular-nums;transition:color .2s,background .2s}.story-length:hover:not(:disabled){color:var(--ink)}.story-length[aria-pressed="true"]{color:#40241a;background:var(--amber)}.story-length:disabled{opacity:.28;cursor:default}.story-progress{height:3px;border-radius:2px;background:rgba(249,237,218,.18);overflow:hidden}.story-progress i{display:block;width:0;height:100%;background:var(--amber);box-shadow:0 0 12px rgba(230,166,83,.5)}.story-note{color:var(--muted);font-size:12px;letter-spacing:.04em;text-align:center;font-variant-numeric:tabular-nums}.story-note[hidden]{display:none}.story-send{padding:16px 22px;border:0;border-radius:28px;color:#40241a;background:var(--amber);font:800 15px/1 "Avenir Next","Gill Sans",sans-serif;letter-spacing:.02em;cursor:pointer;box-shadow:0 12px 28px rgba(230,166,83,.26)}.story-send:active{transform:translateY(1px)}.story-send[hidden],.story-close[hidden]{display:none}.story-close{justify-self:center;padding:9px 18px;border:1px solid rgba(249,237,218,.28);border-radius:20px;color:var(--muted);background:transparent;font:600 12px/1 "Avenir Next","Gill Sans",sans-serif;cursor:pointer}.story-close:hover{color:var(--ink);border-color:rgba(249,237,218,.5)}.player-shell audio{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}@keyframes settle{from{transform:scale(1.06);filter:blur(2px)}to{transform:scale(1.015);filter:blur(0)}}@keyframes fade-down{from{opacity:0;transform:translateY(-8px)}}@keyframes rise{from{opacity:0;transform:translateY(12px)}}@keyframes performance-in{from{opacity:0}to{opacity:1}}@keyframes player-up{from{opacity:0;transform:translate(-50%,18px)}}@keyframes lyric-arrive{from{opacity:0;transform:translateY(9px) scale(.985)}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{opacity:.35;transform:scale(.85)}}@media(max-width:560px){.topbar{height:58px;padding:0 16px}.topbar a{font-size:10px}.performance{padding:64px 14px 148px}.lyric-reveal{padding:18px 14px}.reveal-lines{max-height:max(140px,min(55svh,calc(100svh - 378px)));font-size:18px}.player-shell{bottom:12px;min-height:72px;grid-template-columns:52px 1fr 43px;grid-template-areas:'record track play' 'actions actions actions';border-radius:30px;column-gap:8px;row-gap:2px;padding:8px 12px 6px 8px}.record{grid-area:record}.track{grid-area:track}.play{grid-area:play}.player-actions{grid-area:actions;justify-content:space-evenly}.record{width:50px;height:50px}.record-label{width:22px;height:22px;font-size:11px}.play{width:41px;height:41px}.download{width:40px}.timecode{display:none}.timeline{grid-template-columns:1fr}}@media(max-height:500px){.performance{padding:46px 20px 92px}.lyric-reveal{padding:14px 22px 16px}.performance-timing{margin:2px 0 8px}.reveal-lines{max-height:max(88px,calc(100svh - 302px))}.performance-replay{margin-top:12px;padding:8px 16px;font-size:14px}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;animation-iteration-count:1!important}}
.lyric-line{opacity:.72;transition:color .35s,opacity .35s,text-shadow .35s,transform .35s}.lyric-line.lyric-line-upcoming{opacity:.66}.lyric-line.lyric-line-current{opacity:1;text-shadow:0 0 18px rgba(249,237,218,.3);transform:scale(1.015)}.lyric-line.lyric-cue{opacity:1}.reveal-lines{max-height:310px;font-style:normal;scroll-behavior:smooth}.lyric-section{padding:0;text-align:center}.lyric-section+.lyric-section{margin-top:23px}.lyric-section-current{background:none;box-shadow:none}.lyric-section .lyric-cue{margin:0 0 10px}.lyric-section .lyric-line:not(.lyric-cue)+.lyric-line{margin-top:13px}.lyric-focus{min-height:264px;display:grid;place-items:center;align-content:center}.lyric-focus .lyric-cue{margin:0 0 18px}.lyric-focus .lyric-line-current{margin:15px 0;font-size:clamp(28px,4vw,43px);text-shadow:0 5px 25px rgba(249,237,218,.23)}.lyric-focus .lyric-context{font-size:clamp(15px,1.6vw,18px);opacity:.68}.lyric-focus .lyric-context-next{opacity:.66}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:560px){.lyric-focus{min-height:245px}.lyric-focus .lyric-line-current{font-size:clamp(25px,8vw,35px)}}@media(max-height:500px){.reveal-lines{max-height:max(88px,calc(100svh - 302px))}.lyric-focus{min-height:150px}}@media(prefers-reduced-motion:reduce){.reveal-lines{scroll-behavior:auto}}
</style></head><body>${FOLK_MODERN_SCENE}<div class="grain" aria-hidden="true"></div>
<header class="topbar"><span id="clock">--:--</span><span class="live"><i></i> Music 3.0</span><a href="${escapeHtml(origin)}">Make your own song ${EXTERNAL_LINK_ICON}</a></header>
<main class="performance"><div class="performance-content"><section class="lyric-reveal" aria-label="Lyrics"><strong class="reveal-language">${escapeHtml(label)}</strong><small class="performance-timing">Atmospheric reveal · not synchronized</small><div class="reveal-lines" id="reveal-lines"></div><span class="sr-only" id="lyric-announcer" aria-live="polite" aria-atomic="true"></span></section><button class="performance-replay" id="replay" type="button" hidden>${REPLAY_ICON}<span>Replay the mehfil</span></button></div></main>
<section class="player-shell" id="player-shell" aria-label="Song player"><div class="record" aria-hidden="true"><div class="record-label">M</div></div><div class="track"><strong>${escapeHtml(song.title)}</strong><span>${escapeHtml(label)} · Shared from Mini Mehfil</span><div class="timeline"><input id="seek" type="range" min="0" max="100" value="0" aria-label="Seek"><span class="timecode" id="timecode">0:00 / 0:00</span></div></div><button id="play" class="play" type="button" aria-label="Play ${escapeHtml(song.title)}">${PLAY_ICON}${PAUSE_ICON}</button><div class="player-actions"><button id="share" class="player-action" type="button" aria-label="Copy this song link">${SHARE_ICON}<span>Share</span></button><button id="story" class="player-action" type="button" aria-label="Make a story card for ${escapeHtml(song.title)}">${STORY_ICON}<span>Story</span></button><a class="download" href="${escapeHtml(audioUrl)}" download="${escapeHtml(song.title)}.mp3" aria-label="Save ${escapeHtml(song.title)}">${DOWNLOAD_ICON}<span>Save</span></a></div><audio id="audio" preload="metadata" src="/s/${id}/audio"></audio></section>
<div class="story-stage" id="story-stage" hidden><canvas class="story-canvas" id="story-canvas" width="1080" height="1920" role="slider" tabindex="0" aria-label="Drag to move through the song" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></canvas><div class="story-foot"><span class="story-where" id="story-where"></span><div class="story-lengths" id="story-lengths" role="group" aria-label="How long the story runs"></div><div class="story-progress" id="story-progress" hidden><i id="story-bar"></i></div><span class="story-note" id="story-note">Keep this open while it records</span><button class="story-send" id="story-go" type="button">Record</button><button class="story-close" id="story-close" type="button">Close</button></div></div>
<script id="song-data" type="application/json">${data}</script><script nonce="${nonce}">
const audio=document.querySelector('#audio'),play=document.querySelector('#play'),seek=document.querySelector('#seek'),timecode=document.querySelector('#timecode'),linesRoot=document.querySelector('#reveal-lines'),announcer=document.querySelector('#lyric-announcer'),timingNote=document.querySelector('.performance-timing'),replay=document.querySelector('#replay'),player=document.querySelector('#player-shell'),scene=document.querySelector('.scene'),share=document.querySelector('#share'),song=JSON.parse(document.querySelector('#song-data').textContent);
const lines=Array.isArray(song.lines)?song.lines:[],sections=Array.isArray(song.sections)?song.sections:[],pacing=Array.isArray(song.pacing)?song.pacing:[];
let timeline=Array.isArray(song.timeline)?song.timeline:null,timingValidated=false,renderKey='';
function formatTime(seconds){if(!Number.isFinite(seconds))return'0:00';return Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0')}
function makeLine(value){const element=document.createElement('span');element.className=value.cue?'lyric-line lyric-cue':'lyric-line';if(value.cue){element.textContent=value.primary;return element}const primary=document.createElement('span');primary.className='lyric-primary';primary.textContent=value.primary;element.append(primary);if(value.secondary){const secondary=document.createElement('span');secondary.className='lyric-secondary';secondary.textContent=value.secondary;element.append(secondary)}return element}
function makeCue(value){const element=document.createElement('h3');element.className='lyric-line lyric-cue';element.textContent=value;return element}
function spokenLines(){return sections.flatMap(section=>section.lines.map((line,lineIndexInSection)=>({line,section,lineIndexInSection})).filter(value=>!value.line.cue))}
function makeFocus(section){const current=activeLine(audio.currentTime),cueText=section.lines.find(line=>line.cue)?.primary||'';if(!current)return makeCue(cueText);const spoken=spokenLines(),active=spoken.findIndex(value=>value.section.index===current.sectionIndex&&value.lineIndexInSection===current.lineIndexInSection),element=document.createElement('section');element.className='lyric-section lyric-section-current lyric-focus';element.append(makeCue(cueText));if(active>0){const previous=makeLine(spoken[active-1].line);previous.className+=' lyric-context lyric-context-previous';element.append(previous)}const focused=makeLine(spoken[active].line);focused.className+=' lyric-line-current';focused.setAttribute('aria-current','true');element.append(focused);if(announcer)announcer.textContent=spoken[active].line.primary;if(active<spoken.length-1){const next=makeLine(spoken[active+1].line);next.className+=' lyric-context lyric-context-next';element.append(next)}return element}
function makeAtmospheric(shown){if(!sections.length)return lines.slice(0,shown).map(makeLine);let remaining=shown;return sections.flatMap(section=>{const visible=section.lines.filter(line=>!line.cue).slice(0,remaining);remaining-=visible.length;if(!visible.length)return[];const cue=section.lines.find(line=>line.cue),element=document.createElement('section');element.className='lyric-section';if(cue)element.append(makeCue(cue.primary));visible.forEach(line=>element.append(makeLine(line)));return[element]})}
function activeEntry(currentTime){if(!Number.isFinite(currentTime)||currentTime<0||!timeline)return null;const active=timeline.find(entry=>entry.start<=currentTime&&currentTime<entry.end);if(active)return active;const timelineEnd=timeline[timeline.length-1]?.end;if(!(currentTime>=timelineEnd))return null;return[...timeline].reverse().find(entry=>entry.sectionIndex!==null)||null}
function activeLine(currentTime){if(!Number.isFinite(currentTime)||currentTime<0)return null;const active=pacing.find(entry=>entry.start<=currentTime&&currentTime<entry.end);if(active)return active;const timelineEnd=timeline&&timeline[timeline.length-1]?.end;if(!(currentTime>=timelineEnd))return null;return[...pacing].reverse().find(entry=>entry.sectionIndex===activeEntry(currentTime)?.sectionIndex)||null}
function syncApproximate(){const duration=audio.duration,pacedDuration=duration*.9,progress=pacedDuration>0?Math.min(audio.currentTime/pacedDuration,1):0,spoken=lines.filter(line=>!line.cue),shown=Math.max(spoken.length?1:0,Math.min(spoken.length,Math.ceil(progress*spoken.length))),nextKey='approximate:'+shown;if(renderKey!==nextKey){linesRoot.replaceChildren(...makeAtmospheric(shown));renderKey=nextKey;if(announcer)announcer.textContent=spoken[shown-1]?.primary||'';if(typeof linesRoot.scrollTo==='function')linesRoot.scrollTo({top:linesRoot.scrollHeight,behavior:typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});else linesRoot.scrollTop=linesRoot.scrollHeight}}
function syncSections(){const entry=activeEntry(audio.currentTime),current=activeLine(audio.currentTime),nextKey=entry?entry.start+':'+entry.end+':'+entry.label+':'+entry.sectionIndex+':'+(current?.lineIndexInSection??'none'):'timed-rest',section=entry&&entry.sectionIndex!==null?sections.find(value=>value.index===entry.sectionIndex):null;if(renderKey!==nextKey){renderKey=nextKey;if(section)linesRoot.replaceChildren(makeFocus(section));else if(entry&&(entry.label==='inst'||entry.label==='silence'))linesRoot.replaceChildren(makeLine({cue:true,primary:entry.label==='inst'?'Instrumental':'Pause',secondary:''}));else linesRoot.replaceChildren()}}
function validateTimelineDuration(){const duration=audio.duration,mappedTimeline=Array.isArray(song.timeline)?song.timeline:null,tolerance=Math.max(1,duration*.02);timingValidated=Boolean(mappedTimeline&&Number.isFinite(duration)&&duration>0&&Math.abs(song.expectedDurationSeconds-duration)<=tolerance);timeline=timingValidated?mappedTimeline:null;timingNote.textContent=timingValidated?'Lines follow MiniMax sections · timing is approximate':'Atmospheric reveal · not synchronized';renderKey=''}
function sync(){if(timingValidated)syncSections();else syncApproximate();const duration=audio.duration;seek.value=duration?(audio.currentTime/duration)*100:0;timecode.textContent=formatTime(audio.currentTime)+' / '+formatTime(duration)}
let visualFrame=0;
function refreshWhilePlaying(){sync();if(audio.paused||audio.ended){visualFrame=0;return}visualFrame=requestAnimationFrame(refreshWhilePlaying)}
function startVisualRefresh(){if(!visualFrame)visualFrame=requestAnimationFrame(refreshWhilePlaying)}
function stopVisualRefresh(){if(visualFrame){cancelAnimationFrame(visualFrame);visualFrame=0}sync()}
function setPlaying(playing){player.classList.toggle('playing',playing);scene.classList.toggle('is-performing',playing);play.setAttribute('aria-label',playing?'Pause':${playLabel})}
play.addEventListener('click',()=>audio.paused?audio.play():audio.pause());audio.addEventListener('play',()=>{replay.hidden=true;setPlaying(true);sync();startVisualRefresh()});audio.addEventListener('pause',()=>{setPlaying(false);stopVisualRefresh()});audio.addEventListener('timeupdate',sync);audio.addEventListener('loadedmetadata',()=>{validateTimelineDuration();sync()});audio.addEventListener('ended',()=>{replay.hidden=false;setPlaying(false);stopVisualRefresh()});seek.addEventListener('input',()=>{if(audio.duration){replay.hidden=true;audio.currentTime=(Number(seek.value)/100)*audio.duration;sync()}});replay.addEventListener('click',()=>{replay.hidden=true;audio.currentTime=0;sync();audio.play()});let shareSettle=0;share.addEventListener('click',async()=>{const label=share.querySelector('span');clearTimeout(shareSettle);try{await navigator.clipboard.writeText(location.href);label.textContent='Copied'}catch{label.textContent='Share'}shareSettle=setTimeout(()=>{label.textContent='Share'},2400)});document.querySelector('#clock').textContent=new Intl.DateTimeFormat([],{hour:'numeric',minute:'2-digit'}).format(new Date()).toLowerCase();sync();
// Story card. The drawing, the recording and the share sheet come from the one
// module the host app also uses; only the buttons belong to this page. See
// scripts/build-story-card.ts.
${STORY_CARD_SCRIPT}
let card=song.card;
const story=document.querySelector('#story'),storyLabel=story.querySelector('span');
const stage=document.querySelector('#story-stage'),stageCanvas=document.querySelector('#story-canvas'),stageWhere=document.querySelector('#story-where'),stageLengths=document.querySelector('#story-lengths'),stageProgress=document.querySelector('#story-progress'),stageBar=document.querySelector('#story-bar'),stageNote=document.querySelector('#story-note'),stageGo=document.querySelector('#story-go'),stageClose=document.querySelector('#story-close');
const storyShareable=storyCard.canShareStoryCard(),storyResting=storyShareable?'Story':'Card';
// Every sung line of the song, in order. Scrubbing walks this list; the card
// shows the handful of lines around wherever a person has landed.
const storyLines=sections.length?sections.flatMap(section=>section.lines.filter(line=>!line.cue)):lines.filter(line=>!line.cue);
const storyRecordable=storyShareable&&storyLines.length>0&&Boolean(storyCard.storyVideoType());
const STORY_WINDOW_LINES=5;
let storyDrawing=null,storyBusy=false,storySettle=0,storyVideo=null,storyClip={start:0,seconds:0},storyWanted=20,storyLineStarts=[],storyScrub=null,storyFrame=0,storyChips=[],storyMoved=false;
storyLabel.textContent=storyResting;
story.setAttribute('aria-label',(storyShareable?'Share a story for ':'Download a story card for ')+card.title);
// The Share control returns to its resting caption; this one keeps step with it.
function storySay(text){clearTimeout(storySettle);storyLabel.textContent=text;if(text!==storyResting)storySettle=setTimeout(()=>{storyLabel.textContent=storyResting},2400)}
function storyBlob(){if(!storyDrawing)storyDrawing=storyCard.storyCardBlob(card).catch(error=>{storyDrawing=null;throw error});return storyDrawing}
// Warmed on press so the still card is drawn before the release, keeping the
// share call inside the gesture Safari requires.
story.addEventListener('pointerdown',()=>{storyBlob().catch(()=>{})});
function songDuration(){return Number.isFinite(audio.duration)&&audio.duration>0?audio.duration:0}
function drawPreview(){if(storyFrame)return;storyFrame=requestAnimationFrame(()=>{storyFrame=0;const image=storyCard.readyStoryBackground(card.backgroundUrl);storyCard.drawStoryCard(stageCanvas,card,image)})}
// Which sung line is heard at a moment, by the song's own pacing where it is
// trusted and by even spacing where it is not.
function lineIndexAt(seconds){const duration=songDuration();if(timeline&&pacing.length){let at=0;pacing.forEach((entry,index)=>{if(seconds>=entry.start)at=index});return Math.min(storyLines.length-1,at)}
if(!(duration>0))return 0;return Math.min(storyLines.length-1,Math.floor((seconds/duration)*storyLines.length))}
function lineStartAt(index){if(timeline&&pacing[index])return pacing[index].start;const duration=songDuration();return storyLines.length?(index/storyLines.length)*duration:0}
// The words on the card are the words sung during the clip, so what a person
// reads is always what they are about to hear.
function showFrom(seconds){const duration=songDuration();storyClip=storyCard.storyClipAt(seconds,duration,storyWanted);storyVideo=null;
const first=lineIndexAt(storyClip.start),last=timeline&&pacing.length?lineIndexAt(storyClip.start+storyClip.seconds):first+STORY_WINDOW_LINES-1;
const window=storyLines.slice(first,Math.min(storyLines.length,Math.max(first+1,Math.min(last+1,first+STORY_WINDOW_LINES))));
card={...card,stanza:window.map(line=>({primary:line.primary,secondary:line.secondary}))};
storyLineStarts=timeline&&pacing.length?window.map((line,at)=>lineStartAt(first+at)):[];
storyDrawing=null;drawPreview();
stageCanvas.setAttribute('aria-valuenow',String(Math.round(duration>0?(storyClip.start/duration)*100:0)));
stageCanvas.setAttribute('aria-valuetext',formatTime(storyClip.start)+' to '+formatTime(storyClip.start+storyClip.seconds));
// Nothing else on screen says the card can be dragged, so the line that will
// carry the interval says it first.
stageWhere.textContent=storyMoved?formatTime(storyClip.start)+' – '+formatTime(storyClip.start+storyClip.seconds):'Drag the card to move through the song';
stageGo.textContent=storyClip.seconds>=1?'Record '+Math.round(storyClip.seconds)+'s':'Record';
storyChips.forEach(chip=>{chip.setAttribute('aria-pressed',Number(chip.dataset.seconds)===storyWanted?'true':'false');chip.disabled=Number(chip.dataset.seconds)>songDuration()});
stageNote.hidden=true;stageProgress.hidden=true;stageGo.hidden=false}
function buildLengths(){if(storyChips.length)return;storyChips=storyCard.STORY_CLIP_LENGTHS.map(seconds=>{const chip=document.createElement('button');chip.type='button';chip.className='story-length';chip.textContent=seconds+'s';chip.dataset.seconds=String(seconds);chip.setAttribute('aria-pressed','false');chip.addEventListener('click',()=>{if(storyBusy)return;storyWanted=seconds;storyMoved=true;showFrom(storyClip.start)});stageLengths.append(chip);return chip})}
// The card is the scrubber: dragging it walks the song, and the words move
// with it. There is nothing else on screen to aim at, and nothing else needed.
function scrubBy(event){if(!storyScrub)return;const box=stageCanvas.getBoundingClientRect();if(!box.height)return;
const moved=(event.clientY-storyScrub.y)/box.height*songDuration();showFrom(storyScrub.start+moved);
if(audio.readyState>0){audio.currentTime=storyClip.start;if(audio.paused)audio.play().catch(()=>{})}}
stageCanvas.addEventListener('pointerdown',event=>{if(storyBusy)return;storyScrub={y:event.clientY,start:storyClip.start};stageCanvas.setPointerCapture(event.pointerId);storyMoved=true;stageWhere.hidden=false});
stageCanvas.addEventListener('pointermove',scrubBy);
stageCanvas.addEventListener('pointerup',()=>{storyScrub=null;audio.pause()});
stageCanvas.addEventListener('pointercancel',()=>{storyScrub=null;audio.pause()});
stageCanvas.addEventListener('keydown',event=>{const step=event.key==='ArrowUp'||event.key==='ArrowLeft'?-5:event.key==='ArrowDown'||event.key==='ArrowRight'?5:0;if(!step||storyBusy)return;event.preventDefault();showFrom(storyClip.start+step)});
function closeStage(){stage.hidden=true;storyVideo=null;stageNote.hidden=true;stageProgress.hidden=true;stageBar.style.width='0%';audio.pause()}
stageClose.addEventListener('click',closeStage);
async function record(){const clip=storyClip;if(!storyCard.isRecordableClip(clip)){stageNote.hidden=false;stageNote.textContent='There is not enough song left here to record.';return}
stageGo.hidden=true;stageLengths.hidden=true;stageWhere.hidden=true;stageProgress.hidden=false;stageNote.hidden=false;stageNote.textContent='Keep this open · '+Math.round(clip.seconds)+'s';
try{const blob=await storyCard.recordStoryVideo({canvas:stageCanvas,card,audio,clipStart:clip.start,seconds:clip.seconds,lineStarts:storyLineStarts,onProgress:value=>{stageBar.style.width=(value*100).toFixed(1)+'%';stageNote.textContent='Keep this open · '+Math.ceil(clip.seconds*(1-value))+'s'}});
storyVideo=new File([blob],card.videoFileName,{type:blob.type||'video/mp4'});
stageNote.hidden=true;stageGo.textContent='Share to your story';stageGo.hidden=false}
catch{stageBar.style.width='0%';stageNote.hidden=false;stageNote.textContent='That recording stopped. Try again.';stageGo.textContent='Record '+Math.round(clip.seconds)+'s';stageGo.hidden=false}
finally{stageLengths.hidden=false;stageWhere.hidden=false}}
// A fresh press: transient activation never survives the length of a clip, so
// the sheet cannot be opened from the end of the recording.
stageGo.addEventListener('click',async()=>{if(storyBusy)return;storyBusy=true;
try{if(!storyVideo)await record();
else{try{await navigator.share({files:[storyVideo],title:card.title,text:card.title+' · '+card.url});closeStage()}
catch(error){if(!error||error.name!=='AbortError'){stageNote.hidden=false;stageNote.textContent='That could not be shared. Close and use Save.'}}}}
finally{storyBusy=false}});
async function stillCard(){storyLabel.textContent='…';try{storySay(await storyCard.shareOrSaveStoryCard(await storyBlob(),card)==='saved'?'Saved':storyResting)}catch{storySay('Retry')}}
function openStage(){audio.pause();buildLengths();storyMoved=false;
// Opens where the card already was, so the first thing seen is the card a
// person would have got anyway.
const entry=timeline&&card.sectionIndex!==null?timeline.find(value=>value.sectionIndex===card.sectionIndex):null;
storyCard.loadStoryBackground(card.backgroundUrl).then(()=>{showFrom(entry?entry.start:songDuration()*0.3)}).catch(()=>{});
showFrom(entry?entry.start:songDuration()*0.3);stage.hidden=false}
story.addEventListener('click',async()=>{if(storyBusy)return;storyBusy=true;clearTimeout(storySettle);
try{if(storyRecordable)openStage();else await stillCard()}
catch{closeStage();storySay('Retry')}
finally{storyBusy=false}});
</script></body></html>`;
}
