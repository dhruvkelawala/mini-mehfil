# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primarily the owner (Dhruv), generating songs locally for themself while testing. If it proves itself, the intended second audience is the public running it self-hosted with their own MiniMax API key (BYOK). Design and copy should already read well to a stranger, but no multi-user features exist or are planned.

## Product Purpose

Mini Mehfil is a tiny local song room for MiniMax Music 3: paste a token, type a few keywords in any language, and get a playable, downloadable song with lyrics written for you. Success is a single delightful loop — write → record → listen — with zero setup friction beyond `npm start`.

## Positioning

An immersive single-room experience (inspired by saloon.wtf) rather than a utilitarian API playground: one scene, one form, one player. The BYOK/local-proxy model means no accounts, no server-side storage, and no cost to the operator.

## Operating Context

- Run locally with `npm start` (Node ≥18, default port 4173, `PORT` overridable); UI at `public/`, proxy in `server.js`.
- The proxy forwards requests to `https://api.minimax.io/v1/music_generation`; each generation costs the key owner ≈ $0.15.
- Generated MiniMax audio URLs expire after 24 hours; the Save control exists so users download tracks they want to keep.

## Capabilities and Constraints

- **Zero-dependency Node is binding (reinstated 2026-08-14):** `@earendil-works/pi-ai` briefly powered the lyricist, but its 88 MB / 48-package footprint wasn't worth one-line model swaps, so its wire format was copied into `lyricist.mjs` (Anthropic Messages protocol: `POST {base}/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`) and the dependency removed. Standard library only, no build steps; `public/` stays plain HTML/CSS/JS. Node floor is back to 18.
- **One key for everything:** the same MiniMax token drives the lyricist (`api.minimax.io/anthropic`, Anthropic-compatible) and the music call (`/v1/music_generation`). Never introduce a second required credential — it would break BYOK.
- **Lyrics are sung literally.** MiniMax performs the `lyrics` field verbatim, so keywords must be expanded into a full structured song before generating. Direct music-3.0 generation accepts 1–3,500 lyric chars and 0–2,000 prompt chars (the 10–1,000 figure applies to cover mode only); we target ~1,100 and cap at 3,500. Prompt/lyric craft findings live in `docs/research/minimax-native-vocals.md`.
- Single-page static frontend (`public/index.html`, `styles.css`, `app.js`) served by the Node proxy.
- Privacy posture documented in README: the token lives only in the browser field, is forwarded per-request, and is never logged or stored; lyrics and prompts are not persisted.
- Open decision: whether/when to publish for public BYOK consumption.

## Brand Commitments

The product is named **Mini Mehfil** — a pun on MiniMax, since a *mehfil* is an intimate gathering for music. The wordmark stacks a small amber italic "Mini" directly above the large Devanagari महफ़िल.

The saloon.wtf-inspired dusk-courtyard identity is **binding**: that stacked wordmark, teal/terracotta/amber sunset palette, and the illustrated single-scene SVG background (arches, string lights, lanterns, and the seated ensemble — singer at the harmonium with tabla, dholak, sitar and flute, facing a seated audience). Future design work preserves and deepens this world rather than replacing it. Tone: warm, intimate, slightly poetic ("Write the words. Set the mood. Let them sing.").

## Product Principles

1. One room, one loop — everything serves write → record → listen on a single screen.
2. The user's key, the user's music — never store, log, or phone home with tokens, lyrics, or audio.
3. Stdlib or nothing — features that require a dependency are features to redesign.
4. Warmth over utility chrome — the mehfil atmosphere is the product's differentiation; keep it even in error states and edge cases.
