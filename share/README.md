# Share Worker

The share service stores immutable MP3 recordings and a sibling JSON lyric sheet
in one R2 bucket. It has no database and uses only the Cloudflare runtime.

## Deploy

From this directory, with Wrangler 4.36 or newer authenticated:

```bash
npx wrangler r2 bucket create mini-mehfil-shares
npx wrangler secret put MEHFIL_SHARE_SECRET
npx wrangler r2 bucket lifecycle add mini-mehfil-shares expire-stale-shares --expire-days 30
npx wrangler r2 bucket lifecycle list mini-mehfil-shares
npx wrangler deploy
```

Use the same long, random value for the Worker secret and the local proxy's
`MEHFIL_SHARE_SECRET`. The secret is server-only: never add it to browser code,
HTML, a public environment file, or Wrangler's plaintext `vars` section.

Once a stable public PNG or JPEG is deployed, set `SHARE_PREVIEW_IMAGE_URL` as a
Worker variable to its absolute HTTPS URL. Shared pages then include it in their
Open Graph and Twitter player metadata.

The lifecycle rule applies to both the MP3 and JSON object, so expired shares
fail with the same polite missing-song page. Change the retention period to suit
the account's storage budget.

After deployment, configure both local environment variables and start the app:

```bash
MEHFIL_SHARE_URL=https://mini-mehfil-share.example.workers.dev \
MEHFIL_SHARE_SECRET=replace-with-the-same-random-secret \
npm start
```

## Release smoke test

1. Make a real song locally and press **Share**. Confirm the copied URL uses the
   expected Worker origin and does not contain the MiniMax token.
2. Open the share URL in a private desktop window and on a phone. Tap once to
   play, seek to the middle, and confirm the native and romanized lyrics advance.
3. Verify a byte-range response against the copied URL's `/audio` suffix:

   ```bash
   curl --fail --silent --show-error \
     --header 'Range: bytes=0-1023' \
     --dump-header - \
     --output /dev/null \
     https://mini-mehfil-share.example.workers.dev/s/SHARE_ID/audio
   ```

   Expect `206 Partial Content`, `Accept-Ranges: bytes`, and a matching
   `Content-Range` header.
4. Run `npx wrangler r2 bucket lifecycle list mini-mehfil-shares` and verify the
   expiration rule covers the `shares/` objects. For a non-production expiration
   smoke test, temporarily use a short lifecycle, wait for R2's lifecycle window,
   and confirm the link returns the “left the mehfil” page before restoring the
   production retention period.
