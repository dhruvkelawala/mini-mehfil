# Mini Mehfil

A tiny local song room for [MiniMax Music 3](https://platform.minimax.io/docs/api-reference/music-generation), inspired by the immersive single-room feeling of [saloon.wtf](https://saloon.wtf/). The name is a pun on MiniMax: a *mehfil* is an intimate gathering for music, and this one is mini.

Type a few keywords in any language — `Aloopuri Khavsa`, `monsoon in Mumbai`, `first day of a new job` — and a lyricist model writes a full structured song in the language it detects, then MiniMax Music 3 records it in front of you. Lyrics stay hidden unless you press the button that says *don't press me*.

## Run

```bash
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173) and paste your MiniMax API key ([get one here](https://platform.minimax.io/)). No install step: the app has zero dependencies, standard-library Node only (≥18).

## Cost

Bring your own key. Lyrics cost roughly a tenth of a cent (MiniMax M3 text model); each recorded song is about **$0.15** (MiniMax Music 3). Both calls use the same key.

## Privacy

- Your token lives only in the browser field. It is sent to the local Node proxy per request, forwarded to `api.minimax.io`, and never logged or stored.
- Lyrics and prompts stay local unless you explicitly share a finished song. A share stores the MP3 and its lyric sheet in the configured R2 bucket until its lifecycle rule expires them.
- Generated MiniMax audio URLs expire after 24 hours; use **Save** to download tracks you want to keep. If the optional share Worker is configured, **Share** copies a hosted courtyard link after an explicit click.
- Hosted deployments should configure the Worker so a finished recording can be recovered when iOS suspends the page or drops the original response. Recovery stores only a private 24-hour job checkpoint; it never stores the MiniMax token, prompt, or lyrics.

## Sharing and lifecycle-safe recovery

Deploy the zero-dependency Cloudflare Worker described in [`share/README.md`](share/README.md), configure the same server-only upload secret on both sides, then start the app:

```bash
MEHFIL_SHARE_URL=https://mini-mehfil-share.example.workers.dev \
MEHFIL_SHARE_SECRET=replace-with-a-long-random-secret \
npm start
```

Both variables are optional for local-only use, where synchronous generation continues to work normally. They are required together for lifecycle-safe hosted deployments: before the paid MiniMax call, the server atomically claims the browser's job ID in the Worker; it checkpoints the finished source before replying. A suspended or refreshed tab checks that same job instead of paying for another generation. If the Worker is not configured and the browser loses the response, the app explains that this deployment cannot recover it.

Sharing remains opt-in for each finished song. The proxy resolves a completed private job, downloads its audio, and uploads the MP3 plus the explicitly supplied lyric sheet through an authenticated, idempotent request. The browser never contacts the Worker directly, and neither the MiniMax token nor the Worker secret is exposed to it. In the tab, `sessionStorage` retains one versioned pending job ID and lyric sheet for recovery; it does not retain the token, idea, vibe, request payload, audio URL, or diagnostics.

## How it works

- `server.js` — zero-dependency Node proxy. `POST /api/write-lyrics` asks MiniMax M3 (via their Anthropic-compatible endpoint) to turn your keywords into structured, singable lyrics in the detected language — native script for the singer, romanized for you to read. `POST /api/generate` sends the native-script lyrics plus an expanded production prompt to MiniMax Music 3.
- `lyricist.mjs` — everything provider-specific, quarantined in one file.
- `public/` — one page, plain HTML/CSS/JS. The courtyard scene is a single hand-built SVG.

## Test

```bash
npm test
```
