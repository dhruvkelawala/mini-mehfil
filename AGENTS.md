# Mini Mehfil — agent notes

A tiny local song room for MiniMax Music 3. Keywords in any language go in; a
lyricist model writes structured native-script lyrics and a production prompt,
and MiniMax Music 3 sings them.

`PRODUCT.md` and the README privacy/timing sections are binding product
contracts: change the code and those documents together or not at all.
Preserve the one-key BYOK privacy model and require an explicit user action
before every paid generation.

## Commands

Use Node 24 or newer.

- `pnpm install` (CI uses `pnpm install --frozen-lockfile`)
- `pnpm run dev` — web on 4173 and API on 4174 by default; override with
  `pnpm run dev -- --web-port N --api-port N`
- `pnpm run check` — the full local gate: format, lint, typecheck, worker
  types, unit + worker tests, both builds, dev topology test, bundle budget,
  and a worker dry run
- `pnpm test` — unit and worker tests only
- `pnpm run test:browser` — Playwright journeys (desktop and mobile Chromium)
- `pnpm run test:sync-replay -- /path/to/song.mp3` — host/listener/shared
  parity against real saved audio, producing a video proof artifact
- `pnpm run build`, `pnpm start` — production build and serve

## Topology and deployment

Two independently deployed halves — keep them in step:

- **App (Vercel)**: the host client plus Node API routes from
  `src/server/`, serving `minimehfil.wtf`. Vercel deploys automatically on
  push; previews per branch. Preview env vars are branch-scoped
  (`MEHFIL_PUBLIC_URL`, `MEHFIL_SHARE_URL`, `MEHFIL_SHARE_SECRET`) and the
  share URL and secret must belong to the same worker deployment.
- **Share worker (Cloudflare)**: `src/worker/` deployed as
  `mini-mehfil-share` (production; previews use `mini-mehfil-share-pr17`),
  with shares and generation jobs in the `mini-mehfil-shares` R2 bucket and
  rooms in a Durable Object. Vercel rewrites `/s/*` to it. The shared and
  room pages are worker-rendered HTML templates — host UI restyles do not
  reach them unless `src/worker/` templates change too.
- **Worker deploys**: CI's `deploy-worker` job runs
  `pnpm exec wrangler deploy --config share/wrangler.jsonc` on every push to
  `main` (requires the `CLOUDFLARE_API_TOKEN` repository secret). Manual
  fallback: `pnpm run build` then the same wrangler command, plus
  `--name mini-mehfil-share-pr17` for the preview worker. Never let the
  worker drift behind the app: on 2026-08-17 a stale worker silently
  dropped share timing artifacts for a week's worth of shares.

## Working agreements

- Dependencies are allowed when they deepen module boundaries, provide a
  platform SDK, or enforce build and test quality. Keep runtime dependencies
  small and audited: `solid-js` is the only browser runtime library.
- Never log tokens, signed URLs, lyrics, transcripts, or raw provider
  payloads anywhere. The temporary `[TIMING-DIAGNOSTIC]` instrumentation used
  while Plan 006 was being proven has been removed; reintroduce structured
  diagnostics only behind that same fixed privacy-safe vocabulary.
- Only the normalized section-timing artifact persists — never provider
  transcripts (deliberate product decision, PRODUCT.md).
- Implementation plans and their status live in `plans/README.md`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at `dhruvkelawala/mini-mehfil`, managed via the `gh` CLI.
External pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles use their default strings (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

See `docs/agents/domain.md`. The `CONTEXT.md` and `docs/adr/` files it
describes have not been created yet.
