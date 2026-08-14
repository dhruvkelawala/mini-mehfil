# Mini Mehfil — agent notes

A tiny local song room for MiniMax Music 3. Keywords in any language go in; a
lyricist model writes structured native-script lyrics and a production prompt,
and MiniMax Music 3 sings them.

Run with `npm start`, test with `npm test`. There are **no dependencies** —
standard-library Node only — and no build step. Keep it that way.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at `dhruvkelawala/mini-mehfil`, managed via the `gh` CLI.
External pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles use their default strings (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
