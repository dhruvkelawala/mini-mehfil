# Mini Mehfil

A tiny local song room for [MiniMax Music 3](https://platform.minimax.io/docs/api-reference/music-generation), inspired by the immersive single-room feeling of [saloon.wtf](https://saloon.wtf/). The name is a pun on MiniMax: a _mehfil_ is an intimate gathering for music, and this one is mini.

Type a few keywords in any language — `Aloopuri Khavsa`, `monsoon in Mumbai`, `first day of a new job` — and a lyricist model writes a full structured song in the language it detects, then MiniMax Music 3 records it in front of you. Lyrics stay hidden unless you press the button that says _don't press me_.

## Run

```bash
npm install
npm run dev
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173) and paste your MiniMax API key ([get one here](https://platform.minimax.io/)). Mini Mehfil requires Node 24 or newer.

To build and serve the production app locally:

```bash
npm run build
npm start
```

## Cost

Bring your own key. Lyrics cost roughly a tenth of a cent (MiniMax M3 text model); each recorded song is about **$0.15** (MiniMax Music 3). Both calls use the same key.

## Privacy

- Your token lives only in the browser field. It is sent to the local Node proxy per request, forwarded to `api.minimax.io`, and never logged or stored.
- Lyrics and prompts stay local unless you explicitly share a finished song. A share stores the MP3 and its lyric sheet in the configured R2 bucket until its lifecycle rule expires them.
- Generated MiniMax audio URLs expire after 24 hours; use **Save** to download tracks you want to keep. If the optional share Worker is configured, **Share** copies a production `/s/…` courtyard link after an explicit click.
- Hosted deployments should configure the Worker so a finished recording can be recovered when iOS suspends the page or drops the original response. Recovery stores only a private 24-hour job checkpoint; it never stores the MiniMax token, prompt, or lyrics.

## Sharing and lifecycle-safe recovery

Deploy the Cloudflare Worker described in [`share/README.md`](share/README.md), configure the same server-only upload secret on both sides, then start the app:

```bash
MEHFIL_SHARE_URL=https://mini-mehfil-share.example.workers.dev \
MEHFIL_SHARE_SECRET=replace-with-a-long-random-secret \
npm start
```

Both variables are optional for local-only use, where synchronous generation continues to work normally. They are required together for lifecycle-safe hosted deployments: before the paid MiniMax call, the server atomically claims the browser's job ID in the Worker; it checkpoints the finished source before replying. A suspended or refreshed tab checks that same job instead of paying for another generation. If the Worker is not configured and the browser loses the response, the app explains that this deployment cannot recover it.

On Vercel, `vercel.mjs` reads `MEHFIL_SHARE_URL` at build time and reverse-proxies `/s/:path*` to that Worker without changing the browser URL. Set `MEHFIL_PUBLIC_URL` to the canonical HTTPS origin (currently `https://minimehfil.wtf`) so preview and production deployments copy the same public link. Vercel's `VERCEL_PROJECT_PRODUCTION_URL` is used only as a fallback; keep automatic system environment variables enabled.

The Vercel deployment gives the paid request a five-minute function window and stops the upstream generation after four minutes so there is time to save its final status. A claimed job that still has no final status after five minutes becomes a stable failed checkpoint; it never remains pending indefinitely and is never automatically charged again.

Sharing remains opt-in for each finished song. The proxy resolves a completed private job, downloads its audio, and uploads the MP3 plus the explicitly supplied lyric sheet through an authenticated, idempotent request. The browser never contacts the Worker directly, and neither the MiniMax token nor the Worker secret is exposed to it. In the tab, `sessionStorage` retains one versioned pending job ID and lyric sheet for recovery; it does not retain the token, idea, vibe, request payload, audio URL, or diagnostics.

## Optional live rooms

The same sharing configuration enables live mehfils. Press **Open this mehfil to friends** locally and copy the public listener link. Listeners join without an account, API key, or installation, submit song requests, and hear finished recordings together. The host accepts and orders requests, then explicitly presses **Record** before any paid generation begins; all generation costs remain on the host's MiniMax key.

Rooms are transient and host-controlled. The host's player is authoritative: play,
pause, and seeking are synchronized to listeners, whose room page shows the
current native-script lyric and romanization as the song advances. The public
join URL contains only an eight-character room code. The separate host
credential stays in that browser tab's `sessionStorage`, while the MiniMax key
continues to travel only between the host browser and local proxy.

## How it works

- `src/client/host/` — the Solid host surface and typed controllers. The courtyard scene remains a single hand-built SVG.
- `src/server/` — the typed Node proxy and provider boundary.
- `src/lyrics/` — platform-independent lyric parsing, section timing, and derived line pacing shared by the host and the Worker.
- `src/room/` — platform-independent room protocol, state transitions, and transport ports.
- `src/worker/` — the Cloudflare Worker, room router, and thin `MehfilRoom` Durable Object adapter.

Once a recording finishes, the proxy makes one best-effort call to MiniMax's
free `music_cover_preprocess` endpoint with the same key to learn where the
song's sections fall. When that analysis comes back and lines up with the
written sections, the reveal follows those sections while a syllable-weighted
display heuristic paces the current-line emphasis inside each one. Timed mode
says exactly `Lines follow MiniMax sections · timing is approximate`: provider
truth stops at the section boundaries, and nothing here is line, word, or
karaoke timing.

For inline audio bytes, the host also makes one best-effort, band-limited onset
check and holds the first section's sung lines until the likely vocal entry.
Remote audio URLs and shared pages skip that gate; playback never waits for it.
Both line pacing and the vocal-entry gate are approximate render-time
heuristics. Analysis is capped at 10 seconds and can fail freely; anything less
than a confident section match keeps the original
`Atmospheric reveal · timing is approximate` pacing. Nothing from the provider
analysis is kept except the section boundaries themselves.

The project intentionally keeps dependencies focused. `solid-js` is the only
browser runtime library; Vite, TypeScript, Vitest, Playwright, ESLint, Prettier,
and Wrangler provide build and verification tooling.

## Test

```bash
npm test
npm run test:browser
npm run check
```

`npm test` runs the typed Vitest and Cloudflare Worker suites. The browser
command runs the intercepted Chromium flows. `npm run check` is the same
secret-free verification used by CI: formatting, linting, strict types,
generated binding freshness, unit and Worker tests, both Vite builds, gzip
budgets, and a Wrangler dry-run.
