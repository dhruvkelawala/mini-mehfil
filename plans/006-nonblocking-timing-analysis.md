# Plan 006: Make MiniMax timing analysis non-blocking and retryable

> **Status**: BLOCKED — implementation and every automated gate pass, and the
> real non-blocking/provider path passed on 2026-08-17. One further explicitly
> approved paid operator run is required to record host/live-listener/shared-
> page line parity; do not issue another paid generation under the completed
> one-song approval.
>
> **Execution**: `advisor/005-approximate-line-refinement` was rebased from
> `7c8b596` onto fetched `origin/main` `0d6bd5a` with a recoverable safety
> branch. Implementation is complete through `945e88d`; retained diagnostics
> remain intentionally present until an explicit PR-creation step.

## Metadata

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plan 005 implementation through `7c8b596`
- **Category**: reliability / latency / architecture
- **Captured at**: `7c8b596`, 2026-08-17

## Execution record (2026-08-17)

1. Step 0 completed without a STOP condition. The old tip was preserved as
   `codex/plan006-pre-rebase-7c8b596`, the branch was rebased rather than
   merged, `git range-diff` accounted for Plan 004/005 behavior, 97 focused
   preservation tests passed, the space-free baseline `npm run check` passed,
   and Chromium passed 36/36 before implementation edits.
2. Implementation landed in four reviewable rounds:
   `b06b727` (`feat(server): decouple section timing analysis`), `263ca91`
   (`feat(timing): upgrade playback without blocking`), `7ca2b52`
   (`feat(room): synchronize timed lyrics for listeners`), and `945e88d`
   (`feat(timing): verify shared playback parity`). Claude Opus 4.8 structured
   review ran after every round; all accepted findings were fixed and every
   final rerun was clean.
3. The final exact space-free `npm run check` passed with 258 unit tests and 1
   Worker integration test, both builds, all TypeScript/lint/format checks,
   bundle limits and Wrangler dry-run. Chromium passed 38/38 in the source
   worktree. The delayed-analysis browser fixture passed on desktop and mobile
   and proves immediate private playback, late in-place upgrade, terminal
   publication policy, secret-free diagnostics, and equal host/listener/shared
   active lines at the same media clock.
4. The one approved real paid run proved the primary non-blocking outcome: the
   finished song was privately ready after 165,469 ms while the exact pending
   copy was visible; its decoded playback clock advanced before timing settled,
   and Save was immediately enabled. The free provider analysis then returned
   ready on attempt 1 after 23,105 ms (HTTP 200, provider status 0) with 9
   normalized segments. Audible evidence is limited to successful media decode,
   an advancing playback clock and no browser media error; no human subjective
   pacing judgment was recorded.
5. The environment supplied no external room/share configuration. An in-memory
   local adapter was used for those seams, but the privacy-sanitized operator
   harness terminated in its timing/parity sampling stage immediately after the
   successful provider response. It intentionally retained neither generated
   lyrics, signed source, request payload nor replayable artifact, so live
   host/listener/shared-page line equality cannot be reconstructed or truthfully
   claimed. No second paid request was issued.
6. **Exact remaining gate**: one further explicitly approved paid generation,
   using configured external room/share infrastructure or a corrected
   non-persisting operator harness, must observe the same recording switch to
   timed mode without seek/restart and record equal active lines on the host,
   live listener and standalone shared page at sampled media times. This single
   operator parity retest is the only Plan 006 blocker. Diagnostics must remain
   in source through that retest.

## Step 0: mandatory rebase and baseline

Do this only after the operator approves execution and before changing code:

Planning-time observation: the locally known `origin/main` (`453079e`) is not
an ancestor of the current Plan 005 tip. This is evidence that a real rebase is
required, not permission to rely on that possibly stale remote-tracking ref;
fetch first.

1. Stop the dev server attached to this worktree. Require a clean source
   worktree and record the old tip `7c8b596`.
2. Fetch `origin/main`, inspect the incoming range, and create the recoverable
   safety branch `codex/plan006-pre-rebase-7c8b596` at the old tip.
3. Rebase `advisor/005-approximate-line-refinement` onto the newly fetched
   `origin/main`. Do not merge main into the feature branch. If conflicts occur,
   use the repository's merge-conflict workflow and preserve both current main
   behavior and Plan 005 timing behavior. Stop for operator review on semantic
   conflicts in generation, lyric timing, room protocol, sharing or playback.
4. Use `git range-diff` plus focused tests to prove the rebased branch still
   contains the Plan 004/005 behavior: provider artifact validation, one active
   host section/line, backward seek, remote no-fetch, shared-page timing, and
   Hide/Show-control removal.
5. Run the full baseline gate before Plan 006 edits. Use a space-free archive
   for the known `%20` lint-config problem and run Chromium from the source
   worktree. Stop if the rebased baseline fails for a reason not already
   documented.

## Confirmed problem

Section analysis currently runs synchronously after paid music generation but
before `/api/generate` returns the finished song. The first live repair raised
the deadline from 10 seconds to 60 seconds after a real preprocess call took
31.8 seconds. A later operator run still returned Atmospheric reveal. Temporary
privacy-safe instrumentation captured the exact terminal event:

```text
stage=provider-analysis outcome=unavailable reason=timeout
elapsedMs=60008 timeoutMs=60000
```

The request never reached media-duration validation or section mapping.
Increasing the synchronous timeout again would keep the finished song hostage
to an optional, latency-variable provider call and merely move the cutoff.

## Design decision

Split paid generation and free timing analysis into two browser-owned requests.
`/api/generate` returns the finished song immediately. The host starts playback,
then a deep `TimingAnalysisController` module runs section analysis in the
background and upgrades the already-loaded player when trusted timing arrives.
The same immutable artifact then crosses the room/share seam; host, live
listener and standalone shared playback must derive section and line state with
the same lyric-sync modules rather than separate pacing implementations.

The controller's external interface should stay small:

```ts
type TimingState =
  | { status: 'idle' }
  | { status: 'pending'; attempt: number }
  | { status: 'ready'; timing: LyricTiming }
  | { status: 'unavailable'; reason: TimingFailureReason };

type SettledTimingState = Extract<
  TimingState,
  { status: 'ready' | 'unavailable' }
>;

interface TimingAnalysisController {
  state(): TimingState;
  analyze(input: { source: string; token: string }): Promise<void>;
  settled(): Promise<SettledTimingState>;
  cancel(): void;
}
```

The implementation hides request timeouts, retry policy, stale-result
suppression, normalization and safe failure classification. The MiniMax
dependency is true external; inject its fetch port so tests use a mock adapter
while production uses the existing HTTP adapter.

## Server seam

1. Move preprocess parsing into a result-returning module:

   ```ts
   type TimingAnalysisOutcome =
     | { status: 'ready'; timing: LyricTiming }
     | {
         status: 'unavailable';
         reason: TimingFailureReason;
         retryable: boolean;
       };
   ```

   `null` is no longer the interface; callers must be able to distinguish a
   timeout/network/provider-busy failure from invalid timing.

2. Add `POST /api/analyze-timing`. It accepts the same request-only MiniMax
   token and the finished HTTPS source already returned to that browser. It
   returns only the discriminated outcome above. Never return or log provider
   transcripts, signed URLs, tokens, prompts, lyrics, trace ids, feature ids or
   raw payloads.

3. Remove the preprocess await from `/api/generate`. Generation behavior,
   billing, payload and recovery stay unchanged; the response contains audio as
   soon as Music 3 finishes.

4. Keep a bounded deadline because external calls may hang, but move it off the
   song-delivery path. Start with 180 seconds per attempt and at most two
   attempts. Retry only timeout, network failure, HTTP 408/429/5xx and explicit
   provider-busy results. Do not retry authentication, malformed response,
   invalid timing or unsupported source failures.

## Diagnostic contract during implementation

Keep privacy-safe structured console diagnostics for the entire implementation
and live-test period. **Do not remove them when automated tests or the operator
gate first pass. Remove the console emission only during explicit PR creation.**

Use the fixed prefix `[TIMING-DIAGNOSTIC]` and emit one event at each meaningful
transition:

- provider request start, response, timeout, retry and terminal outcome;
- host artifact receipt, source/media validation and section-map outcome;
- share/room publication waiting, ready or terminal-untimed decision;
- live listener artifact receipt, media validation and section-map outcome;
- standalone shared playback validation when its existing inline harness runs.

Permitted fields are fixed reason codes, surface, attempt number, elapsed
milliseconds, configured deadline, HTTP/provider numeric status, segment/section
counts and analyzed/media durations. Never include tokens, authorization,
signed URLs, audio bytes, prompts, lyrics, provider payloads/transcripts,
trace ids, feature ids, room credentials or participant data. Tests must assert
that diagnostics distinguish every fallback seam and remain secret-free.

At PR creation, delete temporary console calls and their debug-only plumbing,
then re-run all gates. Keep the discriminated outcomes, retry state and
behavioral tests; only observational logging is temporary.

## Host seam

1. Start background analysis only for a newly generated HTTPS recording. Inline
   hex, recovered legacy songs and room listener playback retain their existing
   paths unless they already carry trusted timing.

2. Add a source-keyed `player.applyTiming(expectedSource, timing)` interface.
   It owns normalization and media-duration matching and refuses results for a
   replaced recording. A run counter plus `AbortController` prevents an older
   song's completion from changing the current song.

3. Render three honest states:

   - pending: `Analyzing MiniMax sections · music is ready`
   - trusted and mapped: existing timed copy
   - terminal failure or weak mapping: existing Atmospheric copy

   Playback never waits, restarts or seeks when timing arrives. Existing
   current-clock pacing must activate at the current media position.

4. Save remains immediately available and independent. A Share action requested
   while analysis is pending waits on `settled()` while playback continues. It
   publishes the trusted artifact on success or an explicitly terminal untimed
   share after retries are exhausted. This prevents a standalone listener link
   from being permanently created just before timing becomes ready.

## Listener and shared-playback parity

The current live-listener surface is not at parity: `RoomSong` carries lyrics
and playback but no timing, and the listener renders only the first lyric line.
Plan 006 must close that gap rather than stopping at the host.

1. Add optional normalized `lyricTiming` to `RoomSong`, room snapshot parsing,
   `song-shared`/`song-ready` events and state transitions. Preserve absent/null
   timing for old rooms and shares.
2. Room publication waits for the background analysis's terminal state while
   private host playback continues. When ready, upload/share metadata and the
   room event carry the same immutable artifact. If all retries fail, publish an
   explicitly untimed song; listeners use Atmospheric reveal exactly as the
   host does.
3. Pass room timing into the host's `loadRoomSong` path instead of clearing it.
   The host must not lose timed mode when switching from its private source to
   the shared room audio URL.
4. Replace the listener's first-line-only view with the same parsed-section,
   timeline, syllable pacing, active-section and `aria-current` rules used by
   the host. Extract a shared timed-lyrics renderer/model where that reduces
   duplication. Both room surfaces use remote audio, so both deliberately skip
   the inline-byte vocal-onset gate.
5. Drive listener lyric state from its real media clock, including host pause,
   resume, forward/backward seek, reconnect and late metadata. Applying timing
   must never restart audio or alter synchronized playback position.
6. Keep the existing Worker shared page on the same `buildSectionTimeline` and
   `buildLinePacing` contract. A recording shared after timing readiness must
   show the same active section/line at the same media time on host, live
   listener and standalone shared playback.

## Tests and gates

1. Server contract tests: generation does not call preprocess; analysis returns
   ready, retryable timeout/network/provider-busy, and terminal invalid-result
   outcomes without leaking secrets.
2. Deterministic controller tests with fake timers: immediate song readiness,
   bounded retry, cancellation, stale-result rejection and terminal fallback.
3. Player tests: late `applyTiming` validates source and duration without
   restarting playback or mutating the provider artifact.
4. Host DOM test: pending display upgrades to exactly one timed section and one
   `aria-current` line at the existing media clock.
5. Room protocol/state tests prove optional timing validation, legacy absence,
   host publication after readiness, and terminal untimed publication.
6. Listener controller/DOM tests prove the same active section and line as the
   host at equal media times, including pause, resume, backward seek, reconnect,
   duration rejection and no vocal-onset fetch.
7. Worker shared-page tests use the same representative timeline and assert the
   same line at the same timestamps. Share/room fixtures without timing remain
   backward-compatible.
8. Browser fixtures with deliberately delayed analysis prove immediate private
   host playback, later timed upgrade, and matching host/live-listener rendering
   on desktop and mobile. Capture the `[TIMING-DIAGNOSTIC]` sequence.
9. Run the full repository check from a space-free archive to avoid the known
   `%20` lint configuration defect, then run Chromium in the source worktree.
10. Operator gate: one real song must become privately playable before analysis
    finishes and later switch to `Lines follow MiniMax sections`; open a live
    listener and a standalone share and verify the same active line at sampled
    timestamps. Record latency, diagnostic reason codes and audible judgment;
    do not record credentials, signed URLs, lyrics or provider payloads.

## Rejected alternatives

- **Raise the synchronous timeout again**: preserves the wrong coupling and
  delays every successful song by an unbounded optional operation.
- **Fire-and-forget after sending the response**: unreliable in serverless
  runtimes, which may suspend the invocation immediately.
- **Process-local analysis jobs plus polling**: introduces process affinity and
  ephemeral job state without improving the browser-owned local workflow.
- **SSE/streaming generation response**: vulnerable to proxy buffering and adds
  protocol complexity when one ordinary follow-up request is sufficient.

## Completion gate

Plan 006 is DONE only when real playback is available before analysis resolves,
the same recording upgrades to timed mode without reload, host/live-listener/
shared-page active lines agree at sampled media times, and timeout no longer
causes the paid generation result to wait or disappear. Keep diagnostics until
the PR-creation step, remove them there, re-run the complete gate, then resume
Plan 005's 2–3 song audible pacing judgment.
