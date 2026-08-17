# Plan 007: Benchmark and productionize Mac-hosted MLX lyric timing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat b5f4fa4..HEAD -- src/client/host/generation-controller.ts src/client/host/timing-analysis-controller.ts src/client/host/player-controller.ts src/server/index.ts src/server/timing-analysis.ts src/timing/timing-analysis.ts src/lyrics/lyric-sync.ts src/room src/worker test scripts README.md PRODUCT.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. Stop and
> report if the provider contract, timing artifact, privacy model, or playback
> parity behavior no longer matches this plan.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: PR #33 merged and Plan 006 marked DONE
- **Category**: performance / reliability / direction
- **Planned at**: commit `0aa1fc0` (reviewed PR #33 head; merged into `main` as
  `b5f4fa4`), 2026-08-17
- **Issue**: https://github.com/dhruvkelawala/mini-mehfil/issues/35

## Why this matters

MiniMax section analysis is correctly decoupled from paid generation in PR #33,
but its latency and availability remain controlled by a remote optional
service. A throwaway M4 Mac mini prototype analyzed a real 154.9-second song in
21.4 seconds including download, anchored all eight written sections with
scores from 0.90 to 1.00, and was judged approximately 95% accurate by the
operator. A second saved-song measurement showed that section-only decoding
can avoid unused word timestamps and reduce warm decode time from 20.1 seconds
to 12.25 seconds.

The opportunity is to make an operator-owned Mac the primary timing provider
without weakening Mini Mehfil's BYOK privacy model, without blocking playback,
and without making the Mac a single-request failure trap. MiniMax must remain a
working fallback until a multilingual benchmark, overload test, and live
host/listener/shared parity gate prove the local service safe to prefer.

## Current state

### Production app

- `src/client/host/generation-controller.ts:260-268` starts timing only after
  the finished recording has loaded and applies a ready artifact in place:

  ```ts
  if (analysisToken && trustedRemoteAudioSource(source)) {
    void analysis.analyze({ source, token: analysisToken });
    timingSettled = analysis.settled();
    if (!background) {
      void timingSettled.then((settled) => {
        if (settled.status === 'ready')
          player.applyTiming(source, settled.timing);
      });
    }
  }
  ```

- `src/client/host/timing-analysis-controller.ts:12-13` gives each analysis
  attempt 180 seconds and permits two attempts. Lines 58-67 retry only timeout,
  network, provider-busy, and provider HTTP failures. The current retry is
  immediate; it has no queue delay or `Retry-After` contract.
- `src/client/host/timing-analysis-controller.ts:121-128` sends only the signed
  source, request-only MiniMax token, and attempt. A constrained local aligner
  also needs the generated lyric sheet and language hint, but the MiniMax token
  must never be forwarded to the local service.
- `src/server/index.ts:468-503` exposes one `/api/analyze-timing` route that
  calls `analyzeMiniMaxTiming` directly. The server has no provider selection,
  local-service authentication, or fallback composition boundary.
- `src/server/timing-analysis.ts:88-268` is the MiniMax provider adapter. It
  validates HTTPS sources, bounds the upstream request, converts provider
  errors into a discriminated outcome, normalizes the response, and emits only
  privacy-safe diagnostics. Preserve this adapter as the fallback and as the
  implementation pattern for a new provider module.
- `src/lyrics/lyric-sync.ts:82-92` defines version 1 timing with the single mode
  `minimax-section-asr`. `normalizeLyricTiming` validates duration, labels,
  ordering, and segment bounds. A local artifact needs an honest provider mode
  while remaining backward-compatible with stored MiniMax artifacts.
- `src/client/host/player-controller.ts:128-175` rejects timing for the wrong
  recording or a materially different media duration and applies valid timing
  without reload, seek, pause, or play. Do not move provider-specific behavior
  into this controller.
- `src/timing/timing-analysis.ts:25-110` defines the fixed diagnostic vocabulary
  and copies only allowed fields to console. The operator explicitly requires
  these diagnostics to remain until separate approval to remove them.
- `test/browser/sync-replay.spec.ts:94-248` is the no-cost real-audio parity
  pattern. It proves one late timing upgrade and equal host, listener, and
  standalone shared active lines, including backward seek, without exposing a
  real token.

### Local prototype evidence

The throwaway prototype is intentionally outside the repository under the
operator's external-NVMe timing-prototype directory. Ask the operator for that
local path, then read its `NOTES.md`, `local_timing_service.py`,
`results/benchmark.json`, and `results/gujarati-single-pass.json`; do not copy
the prototype wholesale or publish its absolute path.

Relevant measured facts:

- M4 Mac mini, 16 GB unified memory; all environments, model caches, temporary
  audio, and results stayed on the external NVMe.
- MLX Whisper Turbo 0.4.3 warmed in about 3 seconds.
- English/code-switched saved song: 186.9 seconds of audio decoded in 20.1
  seconds with word timestamps.
- The same section-oriented configuration without word timestamps decoded the
  saved English track in 12.25 seconds.
- Gujarati saved song: automatic decoding took 143.0 seconds and hallucinated;
  pinned Gujarati, temperature zero, and no previous-text conditioning reduced
  it to 28.1 seconds, but a repeated tail still required rejection.
- Live English song: 1.2-second download, 20.2-second decode, eight of eight
  section anchors, match scores 0.90-1.00, and positive operator judgment.
- The prototype uses a non-blocking process lock. Every simultaneous request
  receives 429 immediately, and the current browser retries immediately, so it
  is not production overload behavior.

### Candidate evaluated, not selected

`KalebJS/whispermlx` is WhisperX with the ASR backend replaced by the same
`mlx-whisper` used above. It disables Whisper word timestamps, adds VAD, then
runs a separate language-specific Wav2Vec2 forced-alignment pass. Its
`batch_size` is currently accepted but unused. It is a benchmark candidate for
line refinement, not evidence that its full PyTorch/Transformers/Pyannote stack
belongs in this app. Its default aligner list includes several Indic languages
but not Gujarati.

Primary references:

- https://github.com/ml-explore/mlx-examples/tree/main/whisper
- https://github.com/KalebJS/whispermlx
- https://github.com/ggml-org/whisper.cpp

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install app | `pnpm install --frozen-lockfile` | exit 0 |
| App typecheck | `pnpm run typecheck` | exit 0, no errors |
| App tests | `pnpm test` | all unit and Worker tests pass |
| App browser tests | `pnpm run test:browser` | all Chromium projects pass |
| Full app gate | `pnpm run check` | exit 0; if the known space-containing-path lint bug recurs, run against an exact space-free archive and record both results |
| No-cost media parity | `pnpm run test:sync-replay -- /absolute/path/to/fixture.mp3` | one generation/timing/share request; host/listener/shared samples agree; proof video written |
| Service unit tests | `python -m unittest discover -s services/local-timing/tests` | exit 0 without loading or downloading an ML model |
| Service benchmark | `services/local-timing/bin/benchmark /absolute/path/to/manifest.json` | machine-readable report written to an ignored NVMe result directory |

## Suggested executor toolkit

- Use the `prototype` skill for benchmark variants; keep them disposable until
  one configuration passes the acceptance thresholds.
- Use the `diagnosing-bugs` skill for any language-specific hallucination,
  section-order mismatch, duration mismatch, or queue starvation.
- Use the `tdd` skill when moving the selected provider contract into source.
- Use `autoreview` before committing each implementation slice.
- Use `crabbox` only if remote Linux validation is useful; MLX inference itself
  must be validated on the Apple Silicon host.

## Scope

**In scope**:

- A reproducible benchmark manifest and scorer using saved/generated songs
  whose exact lyrics, language, duration, and human-marked section boundaries
  are available locally.
- A native macOS MLX timing service under an isolated
  `services/local-timing/` boundary, with its own Python environment/lock and no
  browser bundle or Node runtime dependency.
- Provider-neutral timing contracts and a server-side local-primary,
  MiniMax-fallback adapter.
- Passing the minimum lyric/language context required for constrained local
  alignment while preserving request-only token handling.
- A warm single-worker bounded queue, deduplication, overload signaling,
  temporary-file cleanup, NVMe cache configuration, authenticated loopback/
  tunnel operation, health reporting, and `launchd` lifecycle instructions.
- Backward-compatible host, listener, room, share, and standalone playback
  using the same immutable normalized timing artifact.
- Unit, contract, no-cost media replay, browser parity, overload, privacy, and
  operator verification.
- README, PRODUCT, service runbook, environment-variable documentation, and an
  ADR for the provider/fallback and data-flow decision.

**Out of scope**:

- Replacing paid MiniMax Music 3 generation or the MiniMax lyricist.
- Requiring a second credential from an end user. Operator-only service secrets
  must remain server-side and optional.
- Sending the user's MiniMax token to the Mac service.
- Persisting MiniMax tokens, signed audio URLs, raw provider payloads,
  transcripts, prompts, or full lyric sheets after a request settles.
- Exposing the Python service directly to browsers or binding it to a public
  network interface.
- Speaker diarization, subtitle formats, generic speech-transcription UI, or
  shipping WhisperMLX wholesale without benchmark evidence.
- Word/karaoke animation or a version 2 line-timing artifact. Record measured
  evidence for that separate follow-up instead of expanding this plan.
- Removing `[TIMING-DIAGNOSTIC]` console diagnostics without explicit operator
  approval.

## Git workflow

- Start only after PR #33 is merged. Fetch `origin/main`, require a clean
  worktree, and create `advisor/007-local-mlx-timing` from current main.
- Use conventional commits matching the repository, for example
  `feat(timing): add local analysis provider` and
  `test(timing): cover local queue overload`.
- Commit benchmark/contract, service, app integration, and documentation as
  separate reviewable slices.
- Do not push, deploy, open a PR, create a tunnel, or change hosted environment
  variables unless the operator explicitly authorizes that external action.

## Steps

### Step 1: Freeze a representative, secret-free benchmark corpus

Create a manifest format that points to local audio and local sidecars without
copying audio, credentials, signed URLs, or full generated lyrics into git.
Check in only a schema, synthetic fixture, and scorer tests. Each private local
sidecar must contain language, script choice, section families in written
order, human-marked section starts, duration, and an `audiblyVerified` flag.

Include at least six 2-3 minute songs across:

- clear English pop with repeated choruses;
- English/code-switching;
- Gujarati with native script;
- Hindi or Urdu with native script;
- a sparse intro with late vocal entry;
- dense instrumentation or an intentionally difficult vocal mix.

Reuse saved recordings before authorizing paid generation. Redact benchmark
reports to basename, language, durations, timings, scores, and aggregate error;
never include lyric text or audio URLs.

Acceptance thresholds for the selected warm configuration on this M4/16 GB
host:

- median section-ready wall time at most 15 seconds and p95 at most 30 seconds;
- median absolute section-start error at most 1.5 seconds and p95 at most 3.0
  seconds on audibly verified tracks;
- no section-family occurrence mapped out of order;
- weak/repeated/hallucinated output returns a terminal low-confidence result
  rather than a plausible-looking artifact;
- no large model/cache/temp growth on the internal disk.

**Verify**: run scorer unit tests and the benchmark twice (cold, then warm).
The report must contain all corpus rows, aggregate latency/error, rejection
reasons, disk locations, and no lyrics, URLs, tokens, or audio bytes.

### Step 2: Select the smallest proven decoding/alignment pipeline

Benchmark these candidates through one common adapter:

1. MLX Whisper Turbo with language pinned, temperature zero,
   `condition_on_previous_text=false`, exact lyrics as initial context, and
   segment timestamps only.
2. The same Turbo model with word timestamps, but only if those timestamps are
   actually consumed by alignment/scoring.
3. MLX Turbo 4-bit, measuring both speed and boundary regression.
4. WhisperMLX's VAD plus Wav2Vec2 forced-alignment stage for languages with a
   supported aligner.
5. `whisper.cpp` Turbo with Metal/Core ML as a runtime comparison, without
   changing the target artifact contract.

Choose by the thresholds, not headline transcription speed. Prefer the
dependency-light segment-only MLX path if it passes. Keep a forced-alignment
variant only when it materially improves measured section boundaries without
breaking singing or multilingual coverage. Document rejected variants and
their numbers in the benchmark report/ADR.

**Verify**: the same manifest produces a side-by-side report for every
candidate. At least one candidate passes every threshold. Otherwise STOP.

### Step 3: Define a provider-neutral, backward-compatible contract

Deepen the existing timing boundary rather than branching UI logic:

- extend the version 1 artifact mode to honestly distinguish MiniMax and local
  MLX section analysis while continuing to accept stored
  `minimax-section-asr` artifacts;
- add a minimal sanitized lyric-analysis input containing language code,
  script selection, and the chosen native/roman lyric sheet;
- never forward the MiniMax token to the local service;
- keep `TimingAnalysisOutcome` discriminated and add bounded queue metadata
  only when it changes retry behavior, such as a sanitized `retryAfterMs`;
- add provider-neutral diagnostic events/reasons plus fixed numeric fields for
  queue depth, queue wait, download, and decode latency;
- preserve `player.applyTiming(expectedSource, timing)` and all duration/source
  checks unchanged.

Update pending/timed UI copy so it remains truthful for either provider. Do not
claim line, word, or karaoke timing for a section-only artifact.

**Verify**: focused TypeScript tests prove old MiniMax artifacts, new local
artifacts, invalid modes, source replacement, duration mismatch, retry delay,
and secret-free diagnostics. Typecheck passes.

### Step 4: Turn the selected prototype into a deep local service

Create an isolated native macOS service whose public interface is smaller than
its implementation:

- one authenticated analyze operation returning the normalized outcome;
- one unauthenticated loopback-only health/readiness operation containing only
  version, ready/busy state, and numeric queue depth;
- one model instance warmed at startup;
- one inference worker initially;
- a FIFO queue capped at six waiting jobs;
- deterministic 429 plus bounded `Retry-After` only when the queue is full;
- idempotency/deduplication for retries of the same recording;
- a short-lived cache containing normalized timing only;
- strict body/audio size and duration limits;
- HTTPS source validation with an explicit allowlist or an authenticated
  server-upload alternative;
- download and temporary processing exclusively on the external NVMe;
- deletion in `finally`, including cancellation/error paths;
- repetition, low-anchor, non-monotonic, and duration rejection;
- structured privacy-safe logs with no lyric text, transcript, token, signed
  URL, prompt, raw payload, or participant data.

Split model-free parsing/alignment/queue code from MLX loading so Linux CI can
run standard-library unit tests without installing macOS-only dependencies.
Pin Python and model revisions. Provide a single local run command and a
`launchd` example that sets all Hugging Face, MLX, XDG, and temp/cache paths to
the NVMe. Native MLX must remain outside Docker so it can use Apple Silicon.

**Verify**: service unit tests pass without a model; the Mac integration test
warms once, analyzes every corpus song, leaves no temporary audio, and reports
all large writes on the NVMe. Send ten concurrent fixture requests: one runs,
six wait FIFO, excess requests receive bounded overload responses, accepted
requests complete once, and duplicate IDs do not decode twice.

### Step 5: Compose local primary with MiniMax fallback on the server

Add a server-side provider interface following `analyzeMiniMaxTiming`. Select
the local provider only through explicit server configuration. Authenticate
server-to-service calls with an operator secret that never reaches the browser.
Bind the service to loopback and expose it remotely only through an outbound
tunnel or equivalent authenticated private transport.

Fallback rules must be explicit and tested:

- local ready/validated -> return local artifact;
- local low-confidence/invalid -> call MiniMax while the total browser-owned
  analysis budget still permits it;
- local offline/network/authentication/queue-full after bounded waiting -> call
  MiniMax rather than strand the song in Atmospheric mode;
- MiniMax remains the sole path when local configuration is absent;
- cancellation/stale song -> suppress both results;
- retries use idempotency and bounded backoff rather than starting duplicate
  local decodes.

The route may send exact lyrics/language to the configured operator-owned
service, but must not send the MiniMax token, prompt, idea, vibe, room data, or
share credentials. Update privacy documentation to disclose this optional
operator path accurately.

**Verify**: server contract tests cover local success, every fallback class,
deadline exhaustion, queue delay, malformed local output, duplicate retry,
and local configuration absence. Serialized requests and diagnostics contain
none of the forbidden fields.

### Step 6: Prove playback and publication parity without paid generation

Extend the existing sync-replay fixture so its timing response can come from
the real local service and saved MP3 rather than a hard-coded artifact. The
test must prove:

- private playback starts while local analysis is pending;
- a late local artifact applies without source replacement, reload, seek,
  pause, or play;
- exactly one current line exists;
- forward and backward seeks are stateless;
- share and room publication wait for ready/terminal analysis;
- host, live listener, and standalone shared page use the identical artifact
  and active section/line at equal media clocks;
- local failure uses MiniMax fixture fallback; double failure uses Atmospheric;
- diagnostics show provider selection and fallback without sensitive values.

Record a proof video from the no-cost saved-audio path. No test may read a real
MiniMax token or issue a paid generation request.

**Verify**: focused service/Node/browser tests pass, then run
`pnpm run test:sync-replay` and inspect the machine assertions and privacy audit.

### Step 7: Deploy safely and run a controlled operator gate

Write the runbook before enabling the provider:

- install/update/rollback the pinned service;
- mount/check the NVMe before startup and fail closed if unavailable;
- start/restart with `launchd` and verify model readiness;
- configure the authenticated outbound tunnel without a public listener;
- rotate the service credential;
- inspect queue/latency/fallback diagnostics;
- disable local timing instantly so MiniMax is again sole provider;
- recover from Mac sleep, reboot, tunnel outage, model-download failure, and a
  full queue.

Enable local-primary on a preview deployment only. Reuse saved audio first,
then obtain explicit authorization before any paid live song. Test host,
listener, and shared playback on the same recording. Record provider choice,
queue/decode latency, section count, duration validation, sampled active lines,
and subjective accuracy without recording credentials, signed URLs, lyrics, or
provider payloads.

**Verify**: preview handles local ready, local-offline MiniMax fallback, full
queue, Mac restart, browser refresh, backward seek, listener reconnect, and
shared playback. The production flag remains off until the operator approves
the recorded result.

### Step 8: Run closeout gates and document the decision

Update README, PRODUCT, environment examples, service runbook, and an ADR with
the selected model/runtime, benchmark results, trust boundaries, queue policy,
fallback rules, artifact mode, privacy retention, and rollback switch. Keep
diagnostics per operator instruction.

Run the complete app and service gates. Review every changed file for scope and
run a structured autoreview. Do not merge or enable production from the
executor session.

**Verify**: `pnpm run check`, `pnpm run test:browser`, service unit/integration
tests, benchmark thresholds, overload test, sync replay, privacy scan, and
autoreview all pass. Git status contains only planned files.

## Test plan

- Model-free service tests:
  - lyric cue parsing for Latin and native scripts;
  - language pinning, including Gujarati;
  - sequential repeated-chorus mapping;
  - hallucinated repeated-tail rejection;
  - low-anchor, non-monotonic, invalid-duration, and oversized input rejection;
  - FIFO order, queue cap, cancellation, dedupe, cache TTL, and cleanup.
- Node contract tests, following `test/server/timing-analysis.test.ts`:
  - local and MiniMax adapters normalize to one provider-neutral contract;
  - forbidden fields never cross the local boundary;
  - fallback and retry/backoff classes are exact;
  - legacy MiniMax artifacts remain valid.
- Controller tests, following
  `test/client/host/timing-analysis-controller.test.ts`:
  - delayed retry respects bounded queue wait;
  - cancel/replacement suppresses stale local and fallback results;
  - pending settlement remains share/room-safe.
- Playback/protocol/Worker tests:
  - local mode survives serialization and validates identically on host,
    listener, and standalone playback;
  - source and duration mismatch remain terminal;
  - absent timing remains backward-compatible.
- Browser tests, following `test/browser/sync-replay.spec.ts`:
  - real saved audio through the real local service;
  - pending -> local timed;
  - local failure -> MiniMax fixture timed;
  - both unavailable -> Atmospheric;
  - overload, backward seek, listener reconnect, and three-surface equality.

## Done criteria

- [ ] PR #33 is merged and Plan 006 is marked DONE before implementation starts.
- [ ] A secret-free multilingual corpus and reproducible scorer exist.
- [ ] The selected pipeline meets every latency, accuracy, ordering, rejection,
      and disk-location threshold on the M4/16 GB host.
- [ ] The Mac service keeps one warm model, queues six waiting jobs FIFO,
      deduplicates retries, cleans temporary audio, and fails safely when full.
- [ ] No end user needs a second credential and the MiniMax token never reaches
      the local service.
- [ ] Existing MiniMax timing remains the default/fallback and old artifacts
      still parse.
- [ ] Private playback remains immediate; late timing never reloads, seeks,
      pauses, or starts media.
- [ ] Host, listener, and standalone shared playback agree at sampled forward
      and backward media times using the same local artifact.
- [ ] Mac-offline, tunnel-down, queue-full, low-confidence, malformed-result,
      timeout, and cancellation paths have deterministic tests.
- [ ] All large model/cache/temp writes remain on the NVMe and cleanup is proven.
- [ ] Diagnostics remain present and contain no token, signed URL, lyrics,
      transcript, prompt, payload, room credential, or participant data.
- [ ] `pnpm run check`, `pnpm run test:browser`, `pnpm run test:sync-replay`, service
      tests, benchmark, overload test, privacy scan, and autoreview pass.
- [ ] README, PRODUCT, service runbook, environment reference, and ADR match the
      implementation and include a one-switch rollback to MiniMax-only timing.
- [ ] No production provider flag is enabled without explicit operator approval.

## STOP conditions

Stop and report instead of improvising if:

- PR #33 is not merged, Plan 006 is not DONE, or the drift check reveals a
  changed provider/artifact/playback contract.
- No tested pipeline meets all benchmark thresholds across the representative
  corpus.
- Accurate alignment requires persisting or logging tokens, signed URLs, raw
  provider responses, transcripts, prompts, or full lyric sheets after request
  settlement.
- The local service would require a browser-visible service credential or a
  second credential from end users.
- Generated audio sources cannot be constrained against SSRF with a verified
  host allowlist or an authenticated bounded upload alternative.
- Queue latency cannot stay inside the browser-owned timing budget without
  unsafe parallel inference on the 16 GB Mac.
- Two-worker benchmarking fails to improve sustained throughput or causes
  memory pressure; retain one worker rather than guessing.
- A required model, aligner, or runtime license is incompatible with deployment.
- The NVMe is unavailable and the service would write large artifacts to the
  internal disk.
- The change appears to require weakening source/duration validation, immediate
  playback, host/listener/share parity, or MiniMax fallback.
- Any verification fails twice after a reasonable correction.

## Maintenance notes

- Treat the benchmark manifest and scored results as the regression contract;
  model or decoder upgrades must rerun it before rollout.
- Signed MiniMax URL hostnames may change. Update an allowlist only from
  sanitized observed hostnames and with an SSRF regression test.
- Keep model and Python revisions pinned. An unreviewed model alias update can
  change latency, language behavior, or timestamp quality.
- Queue capacity six is an initial bound derived from measured 12-28 second
  warm analyses and the existing 180-second attempt budget. Recalculate it from
  production p95 rather than increasing it reflexively.
- The local artifact remains section-level. If word-level alignment clearly
  improves the last 5%, create a separate versioned line-timing plan rather
  than silently storing derived line pacing in version 1.
- Reviewer focus: provider fallback must not duplicate expensive local work,
  sensitive inputs must not cross diagnostics or persistence, and every
  playback surface must continue deriving state from one immutable artifact.
