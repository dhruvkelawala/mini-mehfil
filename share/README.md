# Share Worker

The Worker stores immutable MP3 recordings and sibling JSON lyric sheets in R2,
plus private 24-hour generation checkpoints used to recover paid results after
browser suspension. It runs optional live rooms in the `MehfilRoom` Durable Object,
never generates music, and never sees the host's MiniMax key.

## Deploy

Install dependencies from the repository root, then use the pinned Wrangler
tooling. Dependencies are allowed when they deepen a module, provide a platform
SDK, or enforce build/test quality; runtime dependencies remain small and
audited, with `solid-js` the only browser runtime library.

From this directory, with Wrangler authenticated:

```bash
pnpm exec wrangler r2 bucket create mini-mehfil-shares
pnpm exec wrangler secret put MEHFIL_SHARE_SECRET
pnpm exec wrangler r2 bucket lifecycle add mini-mehfil-shares expire-stale-shares --expire-days 30
pnpm exec wrangler r2 bucket lifecycle add mini-mehfil-shares expire-generation-jobs --prefix jobs/ --expire-days 1
pnpm exec wrangler r2 bucket lifecycle list mini-mehfil-shares
pnpm exec wrangler deploy
```

`wrangler.jsonc` binds `ROOMS` to `MehfilRoom`; the `v1` migration adds it as a
SQLite-backed Durable Object class. Deploy this migration to the same Worker as
R2 sharing. It does not replace the `SHARES` or `UPLOAD_RATE_LIMIT` bindings.

## Room architecture

The Durable Object path is deliberately explicit:

```text
wrangler.jsonc: ROOMS binding -> MehfilRoom
src/worker/index.ts: compose sharing and room routers
src/worker/rooms.ts: room HTTP routes and Durable Object namespace adapter
src/worker/mehfil-room.ts: exported Durable Object lifecycle class
src/room/transport.ts: authentication, sockets, persistence, and expiry
src/room/state.ts: pure room state transitions and participant projections
src/client/listener/: Solid listener UI and socket controller
src/worker/room-page.ts: external-asset listener HTML shell
```

Vite builds the listener independently under `dist/listener`. Wrangler's
`ASSETS` binding serves its hashed JavaScript and CSS, while `/r/:roomId`
remains Worker-first so `room-page.ts` can inject the validated room marker and
apply the external-only CSP. Regenerate `worker-configuration.d.ts` after any
binding change with `pnpm run worker:types`.

`createDurableRoomDirectory()` is the only implementation that knows how to
turn a room code into `env.ROOMS.idFromName(roomId)`. Cloudflare therefore sends
every request for a code to the same `MehfilRoom` object. The router and its
tests use the smaller directory interface and do not know about Durable Object
stubs.

Use the same long, random value for the Worker secret and the local proxy's
`MEHFIL_SHARE_SECRET`. The secret is server-only: never add it to browser code,
HTML, a public environment file, or Wrangler's plaintext `vars` section.
`MEHFIL_PUBLIC_URL` is a non-secret Worker variable set in `wrangler.jsonc`; it
keeps playback metadata on the canonical production Vercel origin.

`SHARE_PREVIEW_IMAGE_URL` is the second non-secret Worker variable. It points at
`https://minimehfil.wtf/og/mini-mehfil-card.jpg`, the 1200x630 card committed at
`public/og/` and served from the Vercel origin, and shared pages put it in their
`og:image` and `twitter:image` tags. Shared pages advertise a
`summary_large_image` card rather than a player card, which X renders only for
approved domains; the `og:audio` tags remain for readers that use them. Point the
variable at a different absolute HTTPS URL to change the card, and rerun
`pnpm run worker:types` after editing `vars`.

The share lifecycle rule applies to both the MP3 and JSON object, so expired shares
fail with the same polite missing-song page. Change the retention period to suit
the account's storage budget. The separate `jobs/` prefix rule must remain at one
day or less because recovered MiniMax source URLs expire after 24 hours. Job JSON
contains only the version, job ID, state/timestamps, finished source and optional
trace ID, or a stable public failure. It never contains a MiniMax token, prompt,
lyrics, request headers, raw upstream error, or public share metadata.
Pending is an execution state, not a day-long outcome: after five minutes without
a terminal checkpoint, the Worker atomically records a stable interrupted failure.
This prevents recovery clients from polling an invocation that its host already
terminated, without retrying the paid generation call.

Deploy backward-compatibly: deploy the additive Worker routes and verify the R2
binding, secret, and both lifecycle rules before deploying the Vercel app. To
roll back the app, leave the Worker routes deployed. To roll back the Worker,
roll back the Vercel app first so it does not advertise unavailable recovery.

## Live room security and limits

Room creation uses the existing server-only `MEHFIL_SHARE_SECRET`. The Worker
returns an eight-character public room code and a separate 32-byte host secret.
Only the room code appears in `/r/ROOMCODE` and `/rooms/ROOMCODE/ws`; the host
secret is sent in the first WebSocket message and kept in host `sessionStorage`.
Listeners receive a separate resume credential, also stored only in
`sessionStorage` and represented by a digest in Durable Object storage.

Defaults are 20 connected listeners, 50 queued requests, 40 characters for a
name, 200 for an idea, 120 for a vibe, and 40 for a language. Messages are
limited to 16 KiB and setlists to 100 songs. Every room has a six-hour absolute
cap and expires after a 15-minute period with neither host nor listeners
connected. Finished recordings use the existing R2 share pipeline; best-effort
playback synchronization schedules a common start 1.5 seconds ahead.

After deployment, configure both local environment variables and start the app:

```bash
MEHFIL_SHARE_URL=https://mini-mehfil-share.example.workers.dev \
MEHFIL_SHARE_SECRET=replace-with-the-same-random-secret \
pnpm start
```

## Release smoke test

1. Make a real song on the production app and press **Share**. Confirm the copied
   URL uses the production Vercel origin with an `/s/` path and does not contain
   the MiniMax token or Worker hostname.
2. Open the share URL in a private desktop window and on a phone. Tap once to
   play, seek to the middle, and confirm the native and romanized lyrics advance.
3. Verify a byte-range response against the copied URL's `/audio` suffix:

   ```bash
   curl --fail --silent --show-error \
     --header 'Range: bytes=0-1023' \
     --dump-header - \
     --output /dev/null \
     https://minimehfil.wtf/s/SHARE_ID/audio
   ```

   Expect `206 Partial Content`, `Accept-Ranges: bytes`, and a matching
   `Content-Range` header.

4. Run `pnpm exec wrangler r2 bucket lifecycle list mini-mehfil-shares` and verify the
   expiration rules cover `shares/` and retain `jobs/` no longer than one day. For a non-production expiration
   smoke test, temporarily use a short lifecycle, wait for R2's lifecycle window,
   and confirm the link returns the “left the mehfil” page before restoring the
   production retention period.
5. On a physical iPhone, begin generation and background Safari for at least 60
   seconds after lyrics finish. Return, then repeat with a refresh and with Chrome
   on iPhone. The same recording should load through status recovery, with exactly
   one MiniMax music-generation call for its job ID.
6. Temporarily make status storage unavailable after a claim. The tab should keep
   its checkpoint, offer **Check generation**, and never POST generation again.
   Inspect the R2 job and logs to confirm no token, prompt, lyrics, request body,
   or signed URL query appears outside the private completed `source` field.

### Live room smoke test

1. Deploy the Worker and verify the `MehfilRoom` Durable Object migration succeeds.
2. Open a room locally and confirm the copied listener URL contains no secret.
3. Join from private desktop and iOS Safari sessions without an account or key.
4. Submit, accept, reorder, decline, record, peek, and kick requests.
5. Confirm the host key is absent from room frames, Worker logs, URLs, and R2 metadata.
6. Confirm clients start a finished song near the same offset and a mid-song join seeks forward.
7. Refresh the host and disconnect/reconnect a listener; confirm continuity.
8. Confirm setlist links work and an expired room closes gracefully.
9. In a non-production deployment only, temporarily lower the empty and absolute expiry constants to exercise both alarms, then restore the six-hour and 15-minute production values.
