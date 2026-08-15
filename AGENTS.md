# Mini Mehfil — agent notes

A tiny local song room for MiniMax Music 3. Keywords in any language go in; a
lyricist model writes structured native-script lyrics and a production prompt,
and MiniMax Music 3 sings them.

Run with `npm start` on Node 24 or newer and test with `npm test`. For browser
coverage, run `npm install`, `npx playwright install chromium`, then
`npm run test:browser`. There are **no runtime dependencies** — production is
standard-library Node only, with no build step. Development-only dependencies
are allowed when they provide an automated verification gate.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at `dhruvkelawala/mini-mehfil`, managed via the `gh` CLI.
External pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles use their default strings (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
