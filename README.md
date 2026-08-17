# Mini Mehfil

> Write the words. Set the mood. Let them sing.

**Mini Mehfil turns a few words in any language into a finished song with
[MiniMax Music 3](https://platform.minimax.io/docs/api-reference/music-generation).**
It is a tiny, atmospheric song room rather than another API playground: bring
your own MiniMax key, describe the song, and watch the lyrics and recording come
together in one courtyard.

[Try Mini Mehfil](https://minimehfil.wtf) ·
[Get a MiniMax API key](https://platform.minimax.io/)

_A mehfil is an intimate gathering for music. This one is mini._

## What it does

- **Writes in your language.** Enter a thought such as `monsoon in Mumbai`,
  `Aloopuri Khavsa`, or `first day of a new job`. The lyricist detects the
  language and writes a structured song in native script, with romanization for
  you to follow.
- **Records a complete song.** MiniMax Music 3 turns those lyrics and your
  optional vibe into a playable track.
- **Keeps the experience simple.** One page, one key, and one flow: write →
  record → listen.
- **Lets you keep or share the result.** Download the recording, create an
  expiring public link, or open a live mehfil where friends can request songs
  and listen together.
- **Keeps the stack focused.** The host and listener are built with Solid and
  TypeScript. `solid-js` is the only browser runtime library; the rest of the
  toolchain exists to build, type-check, test, and deploy the app.

## Quick start

You need [Node.js 24 or newer](https://nodejs.org/) and a
[MiniMax API key](https://platform.minimax.io/).

```bash
git clone https://github.com/dhruvkelawala/mini-mehfil.git
cd mini-mehfil
npm install
npm run dev
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173), paste your key, and start
the mehfil.

To build and serve the production app locally:

```bash
npm run build
npm start
```

## Cost

Mini Mehfil is bring-your-own-key. Writing the lyrics costs roughly **$0.001**
and recording a song costs roughly **$0.15** at current MiniMax pricing. The
same key is used for both calls, and a paid recording begins only after you
explicitly start it.

## Privacy

- Your MiniMax key stays in the browser field. It is sent to the local proxy for
  each request, forwarded to `api.minimax.io`, and never logged or stored.
- Your prompt and lyrics are sent to MiniMax to write and record the song, but
  Mini Mehfil does not log or permanently store them. They enter the optional
  sharing service only when you explicitly share a finished song or record it
  for a live room.
- The current tab may temporarily retain one pending job ID and lyric sheet so a
  paid recording can recover after a refresh or iOS suspension. It never retains
  your key, prompt, production request, audio URL, or diagnostics.
- MiniMax audio URLs expire after 24 hours. Use **Save** for anything you want
  to keep.

## Live mehfils

With the optional sharing Worker configured, a host can press **Open this
mehfil to friends** and send the listener link. Guests need no account, API key,
or installation. They can request songs and listen together while the host
controls the queue and playback.

Accepting a request never spends money. Only the host's explicit **Record**
action starts generation, and every generation uses the host's MiniMax key.
Rooms are transient; the public URL contains only an eight-character room code,
while the separate host credential remains in that browser tab.

## Sharing and hosted deployments

Local generation works without any additional services. For expiring share
links, live rooms, and lifecycle-safe recovery on hosted deployments, deploy the
Cloudflare Worker in [`share/`](share/README.md), then run the production app
with:

```bash
MEHFIL_SHARE_URL=https://mini-mehfil-share.example.workers.dev \
MEHFIL_SHARE_SECRET=replace-with-a-long-random-secret \
npm start
```

Both variables are optional for local-only use and must be configured together
when sharing is enabled. The browser never receives the Worker secret, and the
Worker never receives the MiniMax key.

For Vercel, set the same server-only variables plus:

```bash
MEHFIL_PUBLIC_URL=https://minimehfil.wtf
```

`vercel.mjs` reverse-proxies `/s/…` links to the Worker while keeping the public
URL on your chosen origin. The hosted flow checkpoints a completed recording
before replying, allowing the browser to recover it without paying for the same
generation twice after a refresh or mobile suspension.

See [`share/README.md`](share/README.md) for Worker, R2, Durable Object, expiry,
and deployment configuration.

## How it works

1. `POST /api/write-lyrics` asks MiniMax M3, through its Anthropic-compatible
   endpoint, to turn the idea into structured native-script lyrics and
   romanization.
2. `POST /api/generate` sends the native lyrics and an expanded production
   prompt to MiniMax Music 3.
3. The browser plays the returned recording and lets the listener reveal the
   lyrics, download the audio, or explicitly share it.

The code is split around those boundaries:

- `src/client/host/` — the Solid host surface and typed controllers. The
  courtyard remains a single hand-built SVG.
- `src/server/` — the typed Node proxy and provider boundary.
- `src/room/` — the platform-independent room protocol, state transitions, and
  transport ports.
- `src/worker/` — the Cloudflare Worker, room router, and thin `MehfilRoom`
  Durable Object adapter.

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
