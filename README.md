# Mini Mehfil

> Write the words. Set the mood. Let them sing.

**Mini Mehfil turns a few words in any language into a finished song with
[MiniMax Music 3](https://platform.minimax.io/docs/api-reference/music-generation).**
It is a tiny, atmospheric song room rather than another API playground —
inspired by the immersive single-room feeling of
[saloon.wtf](https://saloon.wtf/). Bring your own MiniMax key, describe the
song, and watch the lyrics and recording come together in one courtyard.

[Try Mini Mehfil](https://minimehfil.wtf) ·
[Get a MiniMax API key](https://platform.minimax.io/)

_The name is a pun on MiniMax: a mehfil is an intimate gathering for music, and
this one is mini._

## What it does

- **Writes in your language.** Enter a thought such as `monsoon in Mumbai`,
  `aloo puri`, or `first day of a new job`. The lyricist detects the language
  and writes a full structured song in native script, with romanization for you
  to follow. Lyrics stay hidden unless you press the button that says _don't
  press me_.
- **Records a complete song.** MiniMax Music 3 turns those lyrics and your
  optional vibe into a playable track, recorded in front of you.
- **Keeps the experience simple.** One page, one key, and one flow: write →
  record → listen.
- **Lets you keep or share the result.** Download the recording, create an
  expiring public link, or open a live mehfil where friends can request songs
  and listen together.
- **Keeps the stack focused.** The host and listener are built with Solid and
  TypeScript. `solid-js` is the only browser runtime library; the rest of the
  toolchain exists to build, type-check, test, and deploy the app.

## Quick start

You need [Node.js 24 or newer](https://nodejs.org/),
[pnpm](https://pnpm.io/), and a
[MiniMax API key](https://platform.minimax.io/).

```bash
git clone https://github.com/dhruvkelawala/mini-mehfil.git
cd mini-mehfil
pnpm install
pnpm run dev
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173), paste your key, and start
the mehfil.

To build and serve the production app locally:

```bash
pnpm run build
pnpm start
```

## Cost

Mini Mehfil is bring-your-own-key. Writing the lyrics costs roughly a tenth of
a cent (MiniMax M3 text model); each recorded song is about **$0.15** (MiniMax
Music 3). Both calls use the same key, and a paid recording begins only after
you explicitly start it.

## Privacy

- Your token lives only in the browser field. It is sent to the local Node proxy per request, forwarded to `api.minimax.io`, and never logged or stored.
- Lyrics and prompts stay local unless you explicitly share a finished song. A share stores the MP3 and its lyric sheet in the configured R2 bucket until its lifecycle rule expires them.
- Generated MiniMax audio URLs expire after 24 hours; use **Save** to download tracks you want to keep. If the optional share Worker is configured, **Share** copies a production `/s/…` courtyard link after an explicit click.
- Hosted deployments should configure the Worker so a finished recording can be recovered when iOS suspends the page or drops the original response. Recovery stores only a private 24-hour job checkpoint; it never stores the MiniMax token, prompt, or lyrics.

## Live mehfils

With the optional sharing Worker configured, press **Open this mehfil to
friends** and copy the public listener link. Listeners join without an account,
API key, or installation, submit song requests, and hear finished recordings
together. The host accepts and orders requests, then explicitly presses
**Record** before any paid generation begins; all generation costs remain on
the host's MiniMax key.

Rooms are transient and host-controlled. The host's player is authoritative: play,
pause, and seeking are synchronized to listeners, whose room page shows the
same active lyric section and approximately paced current line as the host. The
public join URL contains only an eight-character room code. The separate host
credential stays in that browser tab's `sessionStorage`, while the MiniMax key
continues to travel only between the host browser and local proxy.

## Sharing and lifecycle-safe recovery

Deploy the Cloudflare Worker described in [`share/README.md`](share/README.md), configure the same server-only upload secret on both sides, then start the app:

```bash
MEHFIL_SHARE_URL=https://mini-mehfil-share.example.workers.dev \
MEHFIL_SHARE_SECRET=replace-with-a-long-random-secret \
pnpm start
```

Both variables are optional for local-only use, where synchronous generation continues to work normally. They are required together for lifecycle-safe hosted deployments: before the paid MiniMax call, the server atomically claims the browser's job ID in the Worker; it checkpoints the finished source before replying. A suspended or refreshed tab checks that same job instead of paying for another generation. If the Worker is not configured and the browser loses the response, the app explains that this deployment cannot recover it.

On Vercel, `vercel.mjs` reads `MEHFIL_SHARE_URL` at build time and reverse-proxies `/s/:path*` to that Worker without changing the browser URL. Set `MEHFIL_PUBLIC_URL` to the canonical HTTPS origin (currently `https://minimehfil.wtf`) so preview and production deployments copy the same public link. Vercel's `VERCEL_PROJECT_PRODUCTION_URL` is used only as a fallback; keep automatic system environment variables enabled.

The Vercel deployment gives the paid request a five-minute function window and stops the upstream generation after four minutes so there is time to save its final status. A claimed job that still has no final status after five minutes becomes a stable failed checkpoint; it never remains pending indefinitely and is never automatically charged again.

Sharing remains opt-in for each finished song. The proxy resolves a completed private job, downloads its audio, and uploads the MP3 plus the explicitly supplied lyric sheet through an authenticated, idempotent request. The browser never contacts the Worker directly, and neither the MiniMax token nor the Worker secret is exposed to it. In the tab, `sessionStorage` retains one versioned pending job ID and lyric sheet for recovery; it does not retain the token, idea, vibe, request payload, audio URL, or diagnostics.

## How it works

- `src/client/host/` — the Solid host surface and typed controllers. The folk-modern scene is shared with listener and Worker playback surfaces through the bundled background assets.
- `src/server/` — the typed Node proxy and provider boundary.
- `src/lyrics/` — platform-independent lyric parsing, section timing, and derived line pacing shared by the host and the Worker.
- `src/room/` — platform-independent room protocol, state transitions, and transport ports.
- `src/worker/` — the Cloudflare Worker, room router, and thin `MehfilRoom` Durable Object adapter.

Once Music 3 finishes, the proxy returns the paid recording immediately and
the host starts playback. The browser then makes a separate request to
MiniMax's free `music_cover_preprocess` endpoint with the same request-only key
to learn where the song's sections fall. Each background attempt has a
three-minute ceiling, with at most two attempts and retries limited to timeout,
network, provider-busy, 408/429 and 5xx failures. A slow or failed optional
analysis can therefore never hold the finished song hostage.

While analysis is pending the performance says exactly
`Analyzing MiniMax sections · music is ready`. When a trusted artifact arrives
and lines up with the written sections and media duration, the already-playing
recording upgrades at its current clock without reload, restart or seek. The
reveal follows those sections while a syllable-weighted display heuristic paces
the current-line emphasis inside each one. Timed mode says exactly
`Lines follow MiniMax sections · timing is approximate`: provider truth stops
at the section boundaries, and nothing here is line, word, or karaoke timing.
Terminal failures and weak mappings keep the existing Atmospheric reveal.

Save remains immediate. A requested standalone share or live-room publication
waits for analysis to become ready or terminal while private playback
continues, then carries either the same normalized immutable timing artifact or
an explicit untimed result. Host, live listener and standalone shared playback
derive active sections and lines from that same artifact and media clock; old
rooms and shares without timing remain compatible.

For inline audio bytes, the host also makes one best-effort, band-limited onset
check and holds the first section's sung lines until the likely vocal entry.
That release is also the first section's line-pacing origin; if analysis
finishes late, pacing starts at the media clock where the hold is released so
hidden intervals cannot skip the opening lines. Provider section boundaries
remain unchanged.
Remote audio URLs and shared pages skip that gate; playback never waits for it.
Both line pacing and the vocal-entry gate are approximate render-time
heuristics. Nothing from provider analysis is kept except normalized section
boundaries; transcripts, trace identifiers, feature identifiers, signed URLs
and derived pacing never enter the persisted timing artifact.

## Test

```bash
pnpm test
pnpm run test:browser
pnpm run test:sync-replay
pnpm run check
```

`pnpm test` runs the typed Vitest and Cloudflare Worker suites. The browser
command runs the deterministic Chromium flows. `pnpm run check` is the same
secret-free verification used by CI: formatting, linting, strict types,
generated binding freshness, unit and Worker tests, both Vite builds, gzip
budgets, and a Wrangler dry-run.

`pnpm run test:sync-replay` is the fast, no-cost real-media loop. It discovers
the fixture named in `test/fixtures/sync-replay-song.json` in `~/Downloads`, or
accepts an explicit MP3:

```bash
pnpm run test:sync-replay -- /absolute/path/to/song.mp3
```

The browser never intercepts generation or timing responses in this mode. The
normal Node proxy talks to an in-process MiniMax stub, which serves the local
MP3 with byte-range support and holds timing until the test explicitly releases
it. The test then samples the same media clock on the host, live-listener, and
standalone shared surfaces—including a backward seek—and requires exactly one
generation, timing, and share request. It clears `MINIMAX_API_TOKEN`, so it
cannot make a paid call. A combined proof video is written to
`.claude/artifacts/sync-replay/sync-replay-proof.webm`.

The checked-in sidecar currently verifies transport, late upgrade, seeking,
and three-surface parity; `audiblyVerified` is deliberately false
because the downloaded MP3 contains no embedded lyric sheet. Replace its lyric
text and section timestamps with a human-checked transcription before treating
the replay as evidence of audible lyric alignment.
