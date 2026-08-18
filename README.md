# Mini Mehfil

> Write the words. Set the mood. Let them sing.

**Mini Mehfil turns a few words in any language into a finished song with
[MiniMax Music 3](https://platform.minimax.io/docs/api-reference/music-generation).**
A tiny, atmospheric song room — not another API playground — inspired by the
single-room feeling of [saloon.wtf](https://saloon.wtf/).

[Try Mini Mehfil](https://minimehfil.wtf) ·
[Get a MiniMax API key](https://platform.minimax.io/)

_The name is a pun on MiniMax: a mehfil is an intimate gathering for music, and
this one is mini._

## What it does

- **Writes in your language.** Type `monsoon in Mumbai` or `aloo puri`; the
  lyricist detects the language and writes a full structured song in native
  script, romanized for you to follow. Lyrics stay hidden unless you press the
  button that says _don't press me_.
- **Records a complete song.** MiniMax Music 3 performs those lyrics and your
  optional vibe, live in front of you.
- **One page, one key, one flow.** Write → record → listen.
- **Keep it or share it.** Download the MP3, create an expiring public link, or
  open a live mehfil where friends request songs and listen together.

## Quick start

Requires [Node.js 24+](https://nodejs.org/), [pnpm](https://pnpm.io/), and a
[MiniMax API key](https://platform.minimax.io/).

```bash
git clone https://github.com/dhruvkelawala/mini-mehfil.git
cd mini-mehfil
pnpm install
pnpm run dev
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173), paste your key, and start
the mehfil. Production build: `pnpm run build && pnpm start`.

## Cost

Bring your own key. Lyrics ≈ $0.001 (MiniMax M3 text model); each recorded song
≈ **$0.15** (MiniMax Music 3). Same key for both calls, and a paid recording
starts only after you explicitly press record.

## Privacy

- Your token lives only in the browser field. It is sent to the local Node
  proxy per request, forwarded to `api.minimax.io`, and never logged or stored.
- Lyrics and prompts stay local unless you explicitly share a finished song. A
  share stores the MP3 and lyric sheet in the configured R2 bucket until its
  lifecycle rule expires them.
- MiniMax audio URLs expire after 24 hours — use **Save** to keep a track. With
  the optional share Worker configured, **Share** copies a production `/s/…`
  link after an explicit click.
- Hosted recovery (for iOS suspensions and dropped responses) stores only a
  private 24-hour job checkpoint — never the token, prompt, or lyrics.

## Live mehfils

With the sharing Worker configured, press **Open this mehfil to friends** and
send the listener link. Guests join with no account, key, or install; they
request songs and hear finished recordings together while the host's player
stays authoritative. Accepting a request never spends money — only the host's
explicit **Record** starts a paid generation, always on the host's key. Rooms
are transient; the join URL carries only an eight-character room code.

## Hosting and sharing

Everything works locally with no extra services. Expiring share links, live
rooms, and paid-generation recovery on hosted deployments need the Cloudflare
Worker:

- [`share/README.md`](share/README.md) — Worker, R2, Durable Object, and
  room configuration
- [`docs/hosted-deployment.md`](docs/hosted-deployment.md) — environment
  variables, Vercel setup, and lifecycle-safe recovery

## How it works

| Directory          | Role                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `src/client/host/` | Solid host surface and typed controllers                          |
| `src/server/`      | Typed Node proxy and provider boundary                            |
| `src/lyrics/`      | Lyric parsing, section timing, and line pacing (platform-neutral) |
| `src/timing/`      | Section-timing analysis of the finished recording                 |
| `src/room/`        | Room protocol, state transitions, and transport ports             |
| `src/worker/`      | Cloudflare Worker, room router, `MehfilRoom` Durable Object       |

`solid-js` is the only browser runtime library; Vite, TypeScript, Vitest,
Playwright, ESLint, Prettier, and Wrangler are tooling. Lyric timing is
section-level, non-blocking, and honest about being approximate — the full
contract lives in [`docs/section-timing.md`](docs/section-timing.md).

## Test

| Command                     | What it runs                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm test`                 | Typed Vitest and Cloudflare Worker suites                                                               |
| `pnpm run test:browser`     | Deterministic Chromium flows (desktop and mobile)                                                       |
| `pnpm run test:sync-replay` | No-cost real-media replay across all playback surfaces — see [docs/sync-replay.md](docs/sync-replay.md) |
| `pnpm run check`            | CI's secret-free gate: format, lint, types, bindings, tests, builds, budgets, Wrangler dry-run          |
