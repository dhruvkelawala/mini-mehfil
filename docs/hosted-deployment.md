# Hosted deployment: sharing and lifecycle-safe recovery

Local generation needs no extra services. For expiring share links, live rooms,
and lifecycle-safe recovery on hosted deployments, deploy the Cloudflare Worker
described in [`../share/README.md`](../share/README.md), configure the same
server-only upload secret on both sides, then start the app:

```bash
MEHFIL_SHARE_URL=https://mini-mehfil-share.example.workers.dev \
MEHFIL_SHARE_SECRET=replace-with-a-long-random-secret \
pnpm start
```

Both variables are optional for local-only use, where synchronous generation
continues to work normally. They are required together for lifecycle-safe
hosted deployments: before the paid MiniMax call, the server atomically claims
the browser's job ID in the Worker; it checkpoints the finished source before
replying. A suspended or refreshed tab checks that same job instead of paying
for another generation. If the Worker is not configured and the browser loses
the response, the app explains that this deployment cannot recover it.

## Vercel

On Vercel, `vercel.mjs` reads `MEHFIL_SHARE_URL` at build time and
reverse-proxies `/s/:path*` to that Worker without changing the browser URL.
Set `MEHFIL_PUBLIC_URL` to the canonical HTTPS origin (currently
`https://minimehfil.wtf`) so preview and production deployments copy the same
public link. Vercel's `VERCEL_PROJECT_PRODUCTION_URL` is used only as a
fallback; keep automatic system environment variables enabled.

The Vercel deployment gives the paid request a five-minute function window and
stops the upstream generation after four minutes so there is time to save its
final status. A claimed job that still has no final status after five minutes
becomes a stable failed checkpoint; it never remains pending indefinitely and
is never automatically charged again.

## Opt-in sharing flow

Sharing remains opt-in for each finished song. The proxy resolves a completed
private job, downloads its audio, and uploads the MP3 plus the explicitly
supplied lyric sheet through an authenticated, idempotent request. The browser
never contacts the Worker directly, and neither the MiniMax token nor the
Worker secret is exposed to it. In the tab, `sessionStorage` retains one
versioned pending job ID and lyric sheet for recovery; it does not retain the
token, idea, vibe, request payload, audio URL, or diagnostics.
