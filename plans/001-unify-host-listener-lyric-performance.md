# Plan 001: Unify host and listener lyric performance presentation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 4e49ccf..HEAD -- src/client/shared src/client/host/App.tsx src/client/host/styles.css src/client/listener/App.tsx src/client/listener/styles.css test/client test/browser/characterization.spec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: PR #29 must be merged first; no other advisor plan
- **Category**: tech-debt
- **Planned at**: commit `4e49ccf`, 2026-08-17
- **Issue**: https://github.com/dhruvkelawala/mini-mehfil/issues/32

## Why this matters

Hosts and listeners are watching the same song in the same mehfil, but the two
surfaces currently present lyrics as unrelated products. The host has a modal,
cumulative performance sheet with optional reveal-all behavior; the listener
has an embedded stage that shows one current cue and line. Role-specific
controls should remain different, but the synchronized lyric frame,
typography, hierarchy, transitions, native-script primary line, and romanized
secondary line should look and behave consistently. A shared timeline and
presentation component will also prevent fixes to lyric parsing or progression
from landing on only one surface.

This is a follow-up to PR #29. Do not execute this plan against `main` until
that PR has merged: the listener media clock and progressing lyric behavior at
commit `4e49ccf` are prerequisites, not work to recreate in this issue.

## Current state

The host and listener are separate Vite builds, but both already use Solid and
the same courtyard color vocabulary. `src/client/host/main.tsx:3-4` and
`src/client/listener/main.tsx:4-5` import different `App.tsx` and `styles.css`
files. Shared TypeScript modules outside either Vite root are already supported:
both surfaces import from `src/room/`.

Relevant files:

- `src/client/host/App.tsx` — owns host lyric parsing, approximate progression,
  reveal-all state, and performance-dialog markup.
- `src/client/host/styles.css` — owns the host transcript/performance styling.
- `src/client/listener/App.tsx` — independently parses the same lyric sheet and
  selects a single current frame from listener media time.
- `src/client/listener/styles.css` — independently styles listener lyric title,
  cue, primary line, and romanization.
- `src/client/host/player-controller.ts` — exposes host `currentTime()` and
  `duration()`; consume these signals but do not change this controller.
- `src/client/listener/listener-room-controller.ts` — exposes listener
  `currentTime()` and `duration()`; consume these signals but do not change this
  controller.
- `test/browser/characterization.spec.ts` — contains the real host/listener
  WebSocket and media-clock harness. Lines 603-700 are the closest exemplar.
- `test/client/listener/App.test.tsx` — current listener rendering test.

The host builds a flat lyric list and counts spoken lines itself
(`src/client/host/App.tsx:79-104`):

```ts
const lyricLines = createMemo(() => {
  const sheet = activeLyrics();
  if (!sheet) return [];
  const roman = sheet.lyricsRoman.split('\n').filter((line) => line.trim());
  const native = sheet.lyricsNative.split('\n').filter((line) => line.trim());
  // ...returns cue, primary, and secondary fields...
});
const shownSpoken = createMemo(() => {
  if (hasRevealed()) return Number.POSITIVE_INFINITY;
  if (!player.duration()) return 0;
  const spoken = lyricLines().filter((line) => !line.cue).length;
  return Math.ceil(
    Math.min(player.currentTime() / (player.duration() * 0.9), 1) * spoken,
  );
});
```

The host then renders every line and progressively unhides them inside the
performance dialog (`src/client/host/App.tsx:998-1044`). Host-only behavior to
preserve includes the reveal toggle, full transcript, replay action, dialog
focus management, and playback controls.

The listener repeats the parsing and progression logic with a different data
shape (`src/client/listener/App.tsx:32-72`):

```ts
function lyricLines(controller: ListenerRoomController) {
  const lines = createMemo(() => {
    const sheet = controller.snapshot()?.currentSong?.lyrics;
    // ...independently creates cue, primary, and secondary fields...
  });
  const current = createMemo(() => {
    const timeline = lines();
    const duration = controller.duration();
    const progress = duration
      ? Math.min(controller.currentTime() / (duration * 0.9), 1)
      : 0;
    return timeline[
      Math.min(Math.floor(progress * timeline.length), timeline.length - 1)
    ];
  });
  return current;
}
```

The listener renders only the selected frame (`src/client/listener/App.tsx:147-153`):

```tsx
<section class="lyric-stage">
  <h2>{song().title}</h2>
  <p class="lyric-cue">{lyrics().cue}</p>
  <p class="lyric-primary">{lyrics().primary}</p>
  <p class="lyric-secondary">{lyrics().secondary}</p>
</section>
```

The CSS is likewise duplicated but visually different. Host lyric rules live
at `src/client/host/styles.css:1227-1304`; listener lyric rules live at
`src/client/listener/styles.css:267-300`. Both surfaces define `--ink`,
`--muted`, and the courtyard amber value at the root. The shared component
must use namespaced classes and those existing tokens instead of introducing a
new visual system.

Repository conventions to match:

- TypeScript is strict; Solid reactivity uses `createMemo` and signal accessors.
- Browser runtime dependencies are deliberately limited to `solid-js`; add no
  dependency for this refactor.
- Components use semantic HTML and explicit accessible labels. Preserve the
  host dialog semantics and keep listener playback read-only.
- Tests use Vitest for deterministic pure/component behavior and Playwright
  for intercepted host/listener flows.
- Commits use Conventional Commit messages, for example
  `fix: drive listener lyrics from the media clock`.
- The lyric timing is explicitly approximate because the generated audio has
  no word- or line-level timestamps. Preserve the existing 90%-of-duration
  model unless a separate product decision changes the protocol.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0; dependencies installed with Node 24+ |
| Focused unit tests | `pnpm exec vitest run test/client/shared/lyric-performance.test.tsx test/client/listener/App.test.tsx` | all focused tests pass |
| Focused browser parity | `pnpm exec playwright test test/browser/characterization.spec.ts --grep "host and listener share the live lyric performance"` | desktop and mobile pass |
| Typecheck | `pnpm run typecheck` | exit 0, no TypeScript errors |
| Full checks | `pnpm run check` | formatting, lint, types, unit/Worker tests, builds, bundle budgets, and Worker dry-run pass |
| Full browser suite | `pnpm run test:browser` | all Chromium desktop/mobile tests pass |

## Suggested executor toolkit

- Use the `impeccable` skill, if available, only for the final visual-polish
  pass. The structural sharing and tests in this plan come first.
- Use Playwright screenshots at desktop and Pixel 5 sizes to compare the host
  and listener lyric stages with the same fixture state. Do not commit generated
  screenshots unless the repository adopts visual snapshot testing separately.

## Scope

**In scope** (the only source/test files you may modify or create):

- `src/client/shared/lyric-timeline.ts` (create)
- `src/client/shared/LyricPerformance.tsx` (create)
- `src/client/shared/lyric-performance.css` (create)
- `src/client/host/App.tsx`
- `src/client/host/styles.css`
- `src/client/listener/App.tsx`
- `src/client/listener/styles.css`
- `test/client/shared/lyric-performance.test.tsx` (create)
- `test/client/listener/App.test.tsx`
- `test/browser/characterization.spec.ts`
- `plans/001-unify-host-listener-lyric-performance.md` (completion record)
- `plans/README.md` (status update only)

**Approved implementation extension (2026-08-18):** after the shared-state
prototype was reviewed, the operator approved matching section-aligned parsing
and the same timed/untimed presentation on the standalone share page. That
adds `src/lyrics/lyric-sync.ts`, `src/worker/playback-page.ts`,
`test/lyrics/lyric-sync.test.ts`, `test/worker/sharing.test.ts`,
`test/browser/sync-replay.spec.ts`, and `test/browser/user-journeys.spec.ts` to
the implementation scope. The room protocol, persistence, deployment
configuration, and player controllers remain out of scope.

**Out of scope** (do not touch even if related):

- `src/client/host/player-controller.ts` and
  `src/client/listener/listener-room-controller.ts` — their media clocks are
  already the inputs to the shared presentation.
- `src/room/`, `src/server/`, `src/worker/`, and `share/` — do not change the
  room protocol, snapshots, persistence, or deployment configuration.
- Host or listener player chrome, recording queues, request forms, and room
  management UI.
- Adding exact karaoke timestamps, lyric alignment metadata, or a new runtime
  dependency.
- Production or preview deployment work.

## Git workflow

- Branch: `feat/unify-lyric-performance`
- Make one or more logical commits using Conventional Commit messages; the
  final change may use `refactor: unify host and listener lyric performance`.
- Do not push or open a PR unless the operator explicitly instructs it.

## Steps

### Step 1: Lock down shared lyric semantics before refactoring

Create `test/client/shared/lyric-performance.test.tsx` with failing tests that
define the shared contract before implementation. Cover:

1. Latin-script lyrics use the romanized source as the primary line and have
   no secondary line.
2. Native-script lyrics use native text as primary and aligned romanization as
   secondary.
3. Bracketed section tags such as `[Verse]` and `[Pre-Chorus]` become cue text,
   not spoken lines.
4. Empty lines do not consume timeline positions.
5. At zero duration/time, the first spoken line is current.
6. At a known time in a 120-second, four-line fixture, the same deterministic
   line is current on both surfaces; at or beyond 90% duration, the final line
   remains current.

Add a Playwright test named exactly
`host and listener share the live lyric performance` to
`test/browser/characterization.spec.ts`. Model its WebSocket/media setup on
the existing listener clock test at lines 603-700. Drive a host page and a
listener page with the same four-line native/romanized lyric sheet and the same
media time. Open the host performance view. Assert both surfaces expose the
same shared lyric-stage root, song title/language, cue, primary line, and
secondary line at time zero and after advancing to 70 seconds. The initial test
must fail against the duplicated implementations for a meaningful parity
reason, not because setup cannot find either surface.

**Verify**:
`pnpm exec vitest run test/client/shared/lyric-performance.test.tsx && pnpm exec playwright test test/browser/characterization.spec.ts --grep "host and listener share the live lyric performance" --project=desktop-chromium`
Result: the new assertions fail on presentation/parity before implementation; all
test setup reaches both lyric surfaces.

### Step 2: Extract one pure lyric timeline model

Create `src/client/shared/lyric-timeline.ts`. It must own all parsing and
approximate time projection now duplicated in both `App.tsx` files. Export
small typed functions rather than Solid signals, for example:

- `parseLyricTimeline(sheet: LyricsSheet): LyricTimeline`
- `lyricFrameAt(timeline, currentTime, duration): LyricFrame`
- a transcript projection/count helper only if the host reveal-all behavior
  needs it

The normalized line type must carry cue, primary, and optional secondary text.
Keep parsing deterministic when native and romanized arrays differ in length:
never show a section tag as a spoken line, never attach a bracketed romanized
cue as secondary text, and fall back to whichever script has usable content.
Keep the existing approximate progression rule: distribute spoken lines over
the first 90% of finite positive media duration and hold the last line for the
remainder. Clamp negative, non-finite, and beyond-duration inputs safely.

Move the Step 1 unit tests to green without importing either host or listener
controller. The timeline module must remain platform-independent and contain
no DOM or Solid code.

**Verify**:
`pnpm exec vitest run test/client/shared/lyric-performance.test.tsx`
Result: all parser and frame-selection cases pass.

### Step 3: Build a shared visual lyric component

Create `src/client/shared/LyricPerformance.tsx` and
`src/client/shared/lyric-performance.css`. The component must consume a
`LyricsSheet`, title/language metadata, `currentTime`, and `duration`; it must
derive its display through `lyric-timeline.ts`.

Provide two explicit presentation modes in the same component/module:

- **Live stage**: the synchronized performance used by both host and listener,
  showing song title/language, current cue, current primary line, and optional
  romanized secondary line.
- **Transcript**: the host-only reveal-all state, showing the full normalized
  lyric sheet while retaining the same title, cue, script hierarchy, color,
  and typography.

Do not create host/listener variants of the live stage. Role-specific controls
belong outside this component. Namespace all shared selectors under a root
such as `.lyric-performance` so they cannot collide with player or form styles.
Use the existing courtyard tokens (`--ink`, `--muted`, amber) and existing font
stack. Include a restrained current-line transition and honor
`prefers-reduced-motion`.

Extend `test/client/shared/lyric-performance.test.tsx` to render both modes and
assert semantic output: headings/labels, cue text, native primary text,
romanized secondary text, current-frame changes, and full transcript content.

**Verify**:
`pnpm exec vitest run test/client/shared/lyric-performance.test.tsx && pnpm run typecheck`
Result: all shared component tests pass and TypeScript reports no errors.

### Step 4: Replace both bespoke render paths without changing role controls

In `src/client/host/App.tsx`, delete the local `lyricLines` and `shownSpoken`
implementations. Inside the existing performance dialog:

- render the shared live stage while playback is active and lyrics have not
  been explicitly revealed;
- render the shared transcript mode after the existing reveal action;
- preserve `lyricsOpen`, `hasRevealed`, generation status, check-generation,
  replay, dialog close/focus behavior, and all host player controls.

In `src/client/listener/App.tsx`, delete the local `lyricLines` implementation
and replace `.lyric-stage` with the same shared live stage, driven by
`controller.currentTime()` and `controller.duration()`. Preserve join,
requests, room activity, audio enablement, and the read-only listener player.

Remove only the now-dead lyric presentation selectors from
`src/client/host/styles.css` and `src/client/listener/styles.css`. Do not move
unrelated layout or player styles into the shared stylesheet.

Update `test/client/listener/App.test.tsx` only as needed for the shared
semantic markup. Complete the browser parity test from Step 1 so it passes at
desktop and mobile sizes. The test must assert behavior and shared semantic
structure, not brittle pixel coordinates.

**Verify**:
`pnpm exec playwright test test/browser/characterization.spec.ts --grep "host and listener share the live lyric performance"`
Result: desktop and mobile pass with matching cue, primary, and secondary content.

### Step 5: Polish and verify the integrated surfaces

Render the same fixture at desktop Chrome and Pixel 5 viewport sizes. Inspect
host and listener screenshots side by side. The shared lyric stage must have
the same hierarchy and visual language on both surfaces, while remaining
appropriately positioned within the host modal and listener courtyard.

Pay particular attention to:

- long native-script and Latin lines wrapping without colliding with player or
  request controls;
- empty cue/secondary fields not reserving distracting whitespace;
- transcript overflow remaining scrollable on landscape phones;
- reduced-motion behavior;
- host reveal-all and replay still working;
- listener progression still following its local media clock.

Do not add one-off host/listener overrides that recreate the divergence. If a
layout adjustment is surface-specific, keep it to outer container sizing and
document why the shared stage itself cannot own it.

**Verify**:

1. `pnpm run check`: all repository checks and both bundle budgets pass.
2. `pnpm run test:browser`: the complete desktop/mobile browser suite passes.
3. `git diff --name-only`: only files listed under **In scope** are present.

## Test plan

- Create `test/client/shared/lyric-performance.test.tsx` for pure timeline and
  shared component coverage. Follow the rendering style in
  `test/client/listener/App.test.tsx` and use deterministic times/durations.
- Add the cross-surface Playwright parity test to
  `test/browser/characterization.spec.ts`, following the WebSocket/media mock
  at lines 603-700.
- Preserve the existing listener playback regression: progress, elapsed time,
  lyric advancement, and visible record animation must still pass.
- Preserve existing host generation/performance and room synchronization tests.
- Required new cases: Latin-only, native plus romanization, section cues,
  blank lines, mismatched script arrays, zero duration, mid-song frame, final
  frame, transcript reveal, and host/listener live-stage parity at two times.

## Done criteria

All conditions must hold:

- [x] `src/client/shared/lyric-timeline.ts`, `LyricPerformance.tsx`, and the
      namespaced shared stylesheet exist and are used by both surfaces.
- [x] `rg -n "function lyricLines|const lyricLines" src/client/host/App.tsx src/client/listener/App.tsx`
      returns no matches.
- [x] The shared unit/component tests cover every case listed in the test plan
      and pass.
- [x] The cross-surface Playwright test proves the host and listener show the
      same cue, primary line, and secondary line for the same sheet/time at
      desktop and mobile sizes.
- [x] Host-only reveal-all, replay, dialog accessibility, and seek/playback
      controls remain intact.
- [x] Listener request, room activity, audio enablement, progress, and lyric
      clock behavior remain intact.
- [x] `pnpm run check` exits 0 without raising host/listener bundle budgets.
- [x] `pnpm run test:browser` exits 0.
- [x] `git diff --name-only` contains no files outside the amended in-scope
      list above.
- [x] No runtime dependency was added.
- [x] `plans/README.md` marks Plan 001 DONE after implementation review.

## STOP conditions

Stop and report; do not improvise if any of these occur:

- PR #29 has not merged, or the listener media clock/progress behavior from
  commit `4e49ccf` is absent on the execution base.
- Current host/listener excerpts no longer match after the drift check.
- Achieving parity appears to require changing either media controller, the
  room protocol, Worker snapshots, server APIs, or deployment configuration.
- Product requirements demand exact lyric/audio timestamps. They do not exist
  in the current `LyricsSheet`; do not invent timing metadata in this plan.
- The shared component requires a new runtime dependency or Vite configuration
  change.
- Either gzip budget fails after two reasonable attempts to remove duplicated
  code/CSS. Do not raise a budget without maintainer approval.
- A verification step fails twice after a reasonable correction.

## Maintenance notes

- Future lyric parsing, cue handling, script alignment, and approximate timing
  changes must land in `src/client/shared/lyric-timeline.ts`, not either app.
- Reviewers should reject host- or listener-specific forks inside the shared
  live stage unless the difference is an accessibility requirement.
- If MiniMax later supplies line-level timestamps, replace the approximate
  projection behind the shared timeline API so both surfaces improve together.
- Exact karaoke timing, visual snapshot infrastructure, and unifying the host
  and listener player controllers are intentionally deferred.
