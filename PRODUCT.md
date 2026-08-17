# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primarily a host generating songs locally with their own MiniMax API key (BYOK). A host may optionally open a transient live mehfil where listeners join without accounts or keys, request songs, and hear the explicitly shared recordings together.

## Product Purpose

Mini Mehfil is a tiny local song room for MiniMax Music 3: paste a token, type a few keywords in any language, and get a playable, downloadable song with lyrics written for you. Success is a single delightful loop — write -> record -> listen — with minimal setup beyond installing dependencies and starting the local app.

## Positioning

An immersive single-room experience (inspired by saloon.wtf) rather than a utilitarian API playground: one scene, one form, one player. The BYOK/local-proxy model means no accounts, no server-side storage, and no cost to the operator.

## Operating Context

- Develop with `pnpm run dev` and serve a production build with `pnpm run build && pnpm start` (Node ≥24, default port 4173, `PORT` overridable); the Solid UI lives under `src/client/` and the proxy under `src/server/`.
- The proxy forwards requests to `https://api.minimax.io/v1/music_generation`; each generation costs the key owner ≈ $0.15.
- Generated MiniMax audio URLs expire after 24 hours; the Save control exists so users download tracks they want to keep.

## Capabilities and Constraints

- **Focused dependencies are allowed:** add a dependency when it deepens a module boundary, provides a platform SDK, or enforces build/test quality. Keep runtime dependencies small and audited; `solid-js` is the only browser runtime library. The lyricist retains the Anthropic Messages wire protocol (`POST {base}/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`) behind a typed provider adapter.
- **One key for everything:** the same MiniMax token drives the lyricist (`api.minimax.io/anthropic`, Anthropic-compatible), the music call (`/v1/music_generation`), and the free section analysis (`/v1/music_cover_preprocess`). Never introduce a second required credential — it would break BYOK.
- **Lyric timing is section-level, non-blocking, and says so.** The paid Music 3 result is returned and played before a separate browser-owned request asks MiniMax to analyze that finished recording. Background analysis uses at most two three-minute attempts and retries only timeout, network, provider-busy, 408/429 and 5xx failures. Section timing is only used when it maps onto the written sections and matches the audio's length within `max(1 s, 2 %)`, and applying it never reloads, restarts or seeks playback. Provider section boundaries that overshoot the provider's own analyzed duration by up to one second are clamped to that duration during normalization; larger overshoots invalidate the artifact. Pending mode reads exactly `Analyzing MiniMax sections · music is ready`; timed mode reads exactly `Lines follow MiniMax sections · timing is approximate`; terminal or weak-map cases keep the Atmospheric reveal. Inside trusted section boundaries, romanized syllable weights pace a current-line emphasis at render time; for inline audio bytes, a best-effort band-limited onset check may hold the first section's sung lines until the likely vocal entry. Both are approximate display heuristics, never line, word, or karaoke timing. Remote URLs and shared pages skip onset analysis. Save remains immediate, while requested room/share publication waits for analysis to become ready or terminal and then carries the same immutable normalized artifact (or an explicit untimed result). Host, live listener and standalone shared playback derive from that artifact and their media clock. Only normalized section boundaries are stored — never derived pacing, onset results, provider transcripts, trace ids, feature ids, signed URLs or credentials.
- **Lyrics are sung literally.** MiniMax performs the `lyrics` field verbatim, so keywords must be expanded into a full structured song before generating. Direct music-3.0 generation accepts 1–3,500 lyric chars and 0–2,000 prompt chars (the 10–1,000 figure applies to cover mode only); we target ~1,100 and cap at 3,500. Prompt/lyric craft findings live in `docs/research/minimax-native-vocals.md`.
- Solid and TypeScript provide two independently built client entries: the host and the room listener. Vite emits static assets served by the Node proxy and Worker respectively.
- Privacy posture documented in README: the token lives only in the browser field, is forwarded per-request, and is never logged or stored. One pending lyric sheet may live temporarily in the current tab's `sessionStorage` so a paid recording can survive refresh or iOS suspension. Optional rooms keep transient queue/presence state in a Durable Object and explicitly shared recordings in R2; the Worker never receives the MiniMax key or generation prompt.
- Live rooms are optional and host-controlled: accepting a listener request does not spend money, and only an explicit host **Record** action runs the existing write -> record -> share pipeline. Private host playback can begin while section analysis is pending; publication waits for the timing decision so every listener receives the same trusted artifact or the same explicit untimed fallback.
- Open decision: whether/when to publish for public BYOK consumption.

## Brand Commitments

The product is named **Mini Mehfil** — a pun on MiniMax, since a _mehfil_ is an intimate gathering for music. The wordmark stacks a small amber italic "Mini" directly above the large Devanagari महफ़िल.

The saloon.wtf-inspired dusk-courtyard identity is **binding**: that stacked wordmark, teal/terracotta/amber sunset palette, and the illustrated single-scene SVG background (arches, string lights, lanterns, and the seated ensemble — singer at the harmonium with tabla, dholak, sitar and flute, facing a seated audience). Future design work preserves and deepens this world rather than replacing it. Tone: warm, intimate, slightly poetic ("Write the words. Set the mood. Let them sing.").

## Product Principles

1. One room, one loop — everything serves write -> record -> listen on a single screen.
2. The user's key, the user's music — never store, log, or phone home with
   tokens. Keep a pending lyric sheet only in the current tab for lifecycle
   recovery and a private finished source for at most 24 hours. Full lyrics and
   audio leave the local app only when the user explicitly shares a finished song
   or records it for a live room, and expire according to the configured share lifecycle.
3. Small, deep dependencies — add libraries only when they own a difficult boundary or materially improve verification; audit runtime and browser cost.
4. Warmth over utility chrome — the mehfil atmosphere is the product's differentiation; keep it even in error states and edge cases.
