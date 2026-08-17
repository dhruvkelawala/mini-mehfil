# Share Worker

The service stores immutable shared MP3 recordings and lyric sheets, plus private
24-hour generation checkpoints used to recover paid results after browser
suspension. It has no database and uses only the Cloudflare runtime.

## Deploy

From this directory, with Wrangler 4.36 or newer authenticated:

```bash
npx wrangler r2 bucket create mini-mehfil-shares
npx wrangler secret put MEHFIL_SHARE_SECRET
npx wrangler r2 bucket lifecycle add mini-mehfil-shares expire-stale-shares --expire-days 30
npx wrangler r2 bucket lifecycle add mini-mehfil-shares expire-generation-jobs --prefix jobs/ --expire-days 1
npx wrangler r2 bucket lifecycle list mini-mehfil-shares
npx wrangler deploy
```

Use the same long, random value for the Worker secret and the local proxy's
`MEHFIL_SHARE_SECRET`. The secret is server-only: never add it to browser code,
HTML, a public environment file, or Wrangler's plaintext `vars` section.
`MEHFIL_PUBLIC_URL` is a non-secret Worker variable set in `wrangler.jsonc`; it
keeps playback metadata on the canonical production Vercel origin.

Once a stable public PNG or JPEG is deployed, set `SHARE_PREVIEW_IMAGE_URL` as a
Worker variable to its absolute HTTPS URL. Shared pages then include it in their
Open Graph and Twitter player metadata.

The share lifecycle rule applies to both the MP3 and JSON object, so expired shares
fail with the same polite missing-song page. Change the retention period to suit
the account's storage budget. The separate `jobs/` prefix rule must remain at one
day or less because recovered MiniMax source URLs expire after 24 hours. Job JSON
contains only the version, job ID, state/timestamps, finished source, optional
trace ID and normalized section timing, or a stable public failure. It never contains a MiniMax token, prompt,
lyrics, request headers, raw upstream error, or public share metadata.
Pending is an execution state, not a day-long outcome: after five minutes without
a terminal checkpoint, the Worker atomically records a stable interrupted failure.
This prevents recovery clients from polling an invocation that its host already
terminated, without retrying the paid generation call.

Deploy backward-compatibly: deploy the additive Worker routes and verify the R2
binding, secret, and both lifecycle rules before deploying the Vercel app. To
roll back the app, leave the Worker routes deployed. To roll back the Worker,
roll back the Vercel app first so it does not advertise unavailable recovery.

After deployment, configure both local environment variables and start the app:

```bash
MEHFIL_SHARE_URL=https://mini-mehfil-share.example.workers.dev \
MEHFIL_SHARE_SECRET=replace-with-the-same-random-secret \
npm start
```

## Release smoke test

1. Make a real song on the production app and press **Share**. Confirm the copied
   URL uses the production Vercel origin with an `/s/` path and does not contain
   the MiniMax token or Worker hostname.
2. Open a timed share URL in a private desktop window and on a phone. Confirm it
   says **Section timing from MiniMax analysis**, shows the whole matching native
   and romanized section at verse/chorus boundaries, clears stale sung lyrics for
   an instrumental or quiet span, and updates immediately after a backward seek.
3. Open an older untimed share (or force a provider-duration mismatch in a test
   deployment). Confirm it says **Atmospheric reveal · timing is approximate**
   and retains the original cumulative lyric reveal rather than stretching or
   guessing section boundaries.
4. Verify a byte-range response against the copied URL's `/audio` suffix:

   ```bash
   curl --fail --silent --show-error \
     --header 'Range: bytes=0-1023' \
     --dump-header - \
     --output /dev/null \
     https://minimehfil.wtf/s/SHARE_ID/audio
   ```

   Expect `206 Partial Content`, `Accept-Ranges: bytes`, and a matching
   `Content-Range` header.
5. Run `npx wrangler r2 bucket lifecycle list mini-mehfil-shares` and verify the
   expiration rules cover `shares/` and retain `jobs/` no longer than one day. For a non-production expiration
   smoke test, temporarily use a short lifecycle, wait for R2's lifecycle window,
   and confirm the link returns the “left the mehfil” page before restoring the
   production retention period.
6. On a physical iPhone, begin generation and background Safari for at least 60
   seconds after lyrics finish. Return, then repeat with a refresh and with Chrome
   on iPhone. The same recording should load through status recovery, with exactly
   one MiniMax music-generation call for its job ID.
7. Temporarily make status storage unavailable after a claim. The tab should keep
   its checkpoint, offer **Check generation**, and never POST generation again.
   Inspect the R2 job and logs to confirm no token, prompt, lyrics, request body,
   or signed URL query appears outside the private completed `source` field.
