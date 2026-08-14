# Share Worker

The share service stores immutable MP3 recordings and a sibling JSON lyric sheet
in one R2 bucket. It has no database and uses only the Cloudflare runtime.

## Deploy

From this directory, with Wrangler 4.36 or newer authenticated:

```bash
npx wrangler r2 bucket create mini-mehfil-shares
npx wrangler r2 bucket lifecycle add mini-mehfil-shares expire-stale-shares --expire-days 30
npx wrangler deploy
```

The lifecycle rule applies to both the MP3 and JSON object, so expired shares
fail with the same polite missing-song page. Change the retention period to suit
the account's storage budget.

After deployment, set `MEHFIL_SHARE_URL` for the local app to the Worker's HTTPS
origin, without a trailing slash.
