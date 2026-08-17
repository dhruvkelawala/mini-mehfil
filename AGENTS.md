# Mini Mehfil — agent notes

A tiny local song room for MiniMax Music 3. Keywords in any language go in; a
lyricist model writes structured native-script lyrics and a production prompt,
and MiniMax Music 3 sings them.

Use Node 24 or newer. Install with `pnpm install`, develop with `pnpm run dev`,
build with `pnpm run build`, serve the production build with `pnpm start`, and
test with `pnpm test`.

Dependencies are allowed when they deepen module boundaries, provide a
platform SDK, or enforce build and test quality. Keep runtime dependencies
small and audited: `solid-js` is the only browser runtime library. Preserve the
one-key privacy model and require an explicit user action before every paid
generation.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at `dhruvkelawala/mini-mehfil`, managed via the `gh` CLI.
External pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles use their default strings (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
