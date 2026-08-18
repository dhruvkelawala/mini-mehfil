# Plan 007: Align exact lyric lines on the operator Mac, falling back to sections

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7c8c892..HEAD -- src/client/host/generation-controller.ts src/client/host/timing-analysis-controller.ts src/client/host/player-controller.ts src/client/shared/lyric-timeline.ts src/client/shared/LyricPerformance.tsx src/server/index.ts src/server/timing-analysis.ts src/lyrics/lyric-sync.ts src/lyrics/line-pacing.ts src/room src/worker test scripts docs/section-timing.md README.md PRODUCT.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. Stop and
> report if the provider contract, timing artifact, privacy model, or playback
> parity behavior no longer matches this plan.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none (launched product on current `main`; Plans 001/006 DONE)
- **Category**: direction / reliability / performance
- **Planned at**: commit `7c8c892`, 2026-08-18 (supersedes the 2026-08-17
  revision written at `0aa1fc0`, which benchmarked MLX-Whisper *section*
  decoding; this revision targets *line-level forced alignment* per
  `docs/research/lyric-timing-alignment.md`)
- **Issue**: https://github.com/dhruvkelawala/mini-mehfil/issues/35

## Why this matters

Lyric sync today is capped by MiniMax `music_cover_preprocess`, which returns
only coarse section labels that are frequently mislabeled or merged (three
production incidents on 2026-08-18 alone; see the regression tests named in
"Current state"). The app now maps those labels defensively — order-preserving
alignment, anchor-guarded inheritance, sandwiched-section recovery — but no
amount of mapping can beat wrong input: the provider's ceiling is the product's
ceiling.

Mini Mehfil holds an unusual advantage: the exact lyric sheet is known and sung
verbatim (`PRODUCT.md`: "Lyrics are sung literally"). That converts the problem
from transcription to **forced alignment** — pinning known text to audio —
which is strictly easier and yields true line-level timestamps.
`docs/research/lyric-timing-alignment.md` (2026-08-18, primary-sourced)
established: no MiniMax endpoint returns finer-than-section timing; hosted and
serverless options are either section-grade (Cloudflare Workers AI Whisper) or
language-incomplete (ElevenLabs has Hindi but not Gujarati); and the best fit
is the operator's M4 Mac mini running vocal separation (HTDemucs) plus
known-text CTC forced alignment (`torchaudio.pipelines.MMS_FA`, whose
underlying MMS models cover 1,100+ languages including Hindi and Gujarati).
The 2026-08 prototype already proved the Mac service shape at ~95% accuracy
and 12–28 s per song.

After this plan: songs get a line-level timing artifact
(`{lineIndex, start, end}` — no lyric text persisted) produced on the Mac,
with today's MiniMax section pipeline as the unchanged automatic fallback, and
the Atmospheric reveal below that. Playback never waits on any of it.

## Current state

### Production app (all paths relative to repo root, at commit `7c8c892`)

- `src/client/host/generation-controller.ts` — after a finished recording
  loads, the host starts non-blocking analysis with a request-only token
  (`analysisTokens` map, lines 163–225) and applies a ready artifact in place.
  Timing never blocks playback, Save, or publication readiness.
- `src/client/host/timing-analysis-controller.ts:10-11` — each attempt gets
  180 s, at most two attempts:
  ```ts
  export const TIMING_ANALYSIS_DEADLINE_MS = 180_000;
  export const TIMING_ANALYSIS_MAX_ATTEMPTS = 2;
  ```
  The HTTP port (line ~118) POSTs `{source, token}` to `/api/analyze-timing`.
  Retries cover only timeout/network/provider-busy/provider-http classes.
- `src/server/index.ts:464` — the single `/api/analyze-timing` route calls
  `analyzeMiniMaxTiming` directly. There is **no provider selection, local
  service authentication, or fallback composition boundary yet** — that is
  what Step 5 builds.
- `src/server/timing-analysis.ts` — the MiniMax provider adapter: validates
  HTTPS sources, bounds the upstream request with `AbortSignal.timeout`,
  classifies failures into the discriminated `TimingAnalysisOutcome`
  (`{status:'ready',timing}` or `{status:'unavailable',reason,retryable}`),
  and normalizes via `normalizeLyricTiming`. Preserve it unchanged as the
  fallback and copy its shape for the new local provider module.
- `src/lyrics/lyric-sync.ts:94-95` — the version-1 artifact contract:
  ```ts
  version: 1;
  mode: 'minimax-section-asr';
  ```
  The file header states the extension rule this plan must follow: "New
  providers or finer-grained sources must arrive as a new `mode`/`version`
  pair rather than by mutating `minimax-section-asr`."
  `buildSectionTimeline` now performs order-preserving family alignment with
  anchor-guarded inheritance and 1:1 sandwiched-section recovery — see the
  regression tests in `test/lyrics/lyric-sync.test.ts` named
  "aligns provider repeats…", "…before the first anchor stays unmapped",
  "a lone segment between anchors…", and "a sandwiched section is not family
  evidence…". These encode the three 2026-08-18 production incidents and must
  keep passing untouched.
- `src/client/shared/lyric-timeline.ts` and
  `src/client/shared/LyricPerformance.tsx` — since PR #39, host, listener,
  and the worker-rendered shared page derive frames from one shared timeline
  module. A line-level artifact plugs in beneath this seam; do not fork
  per-surface logic.
- `src/worker/sharing.ts` / `src/worker/playback-page.ts` — shares persist
  `lyricTiming` (validated with the same `normalizeLyricTiming`) and the
  worker renders the shared page from it. The share worker deploys separately
  via CI's `deploy-worker` job (see `AGENTS.md` "Topology and deployment");
  artifact-format changes are NOT live until that deploy runs.
- `docs/section-timing.md` — **binding product contract** (per `AGENTS.md`).
  It currently promises section-level truth only ("nothing here is line,
  word, or karaoke timing") and the persistence rule "Nothing from provider
  analysis is kept except normalized section boundaries". Steps 3 and 8 must
  update this document in the same commits that change behavior.
- The former `[TIMING-DIAGNOSTIC]` instrumentation was removed with operator
  approval (PR #38). Any diagnostics this plan adds must use a fixed
  privacy-safe vocabulary: never tokens, signed URLs, lyric text,
  transcripts, or raw provider payloads.

### Research findings this plan is built on

Read `docs/research/lyric-timing-alignment.md` in full before Step 1. Key
verified facts (citations therein):

- MiniMax `music_cover_preprocess` returns six fields; `formatted_lyrics` has
  no timing, `structure_result` is section-only. No finer MiniMax timing
  exists on the BYOK key.
- `torchaudio.pipelines.MMS_FA` is a known-text CTC forced aligner; the MMS
  model family covers 1,100+ languages including Hindi and Gujarati (language
  *count* verified; per-language *sung-vocal* accuracy is NOT verified — that
  is what Step 2's benchmark measures).
- Vocal separation before alignment is the documented accuracy lever in the
  lyrics-alignment literature (Demucs/HTDemucs; arXiv:2506.15514).
- WhisperX's default aligners cover `{en,fr,de,es,it}` only; other languages
  need an explicit Hugging Face CTC model. Echogarden is a Node-native DTW
  aligner worth a spike because it could avoid a Python boundary entirely.
- Cloudflare Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`,
  $0.0005/audio-minute) outputs segment-level VTT only — a candidate
  *section-grade fallback* rung, never a line-level source.
- ElevenLabs Forced Alignment covers Hindi but not Gujarati; operator-side
  optional key only; pricing unverified.

### Local prototype evidence (2026-08)

The throwaway prototype lives outside the repository in the operator's
external-NVMe timing-prototype directory. Ask the operator for the path; read
its `NOTES.md` and `results/*.json`. Do not copy it wholesale or publish its
absolute path. Measured: M4 Mac mini 16 GB; MLX Whisper Turbo warmed ~3 s;
186.9 s song decoded in 12.25–20.1 s; live English song 8/8 section anchors
scoring 0.90–1.00; Gujarati open decoding hallucinated until language-pinned.
The prototype's overload behavior (single lock, instant 429, instant browser
retry) is explicitly not shippable.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install app | `pnpm install --frozen-lockfile` | exit 0 |
| App typecheck | `pnpm run typecheck` | exit 0, no errors |
| App tests | `pnpm test` | all unit and Worker tests pass |
| App browser tests | `pnpm run test:browser` | all Chromium projects pass |
| Full app gate | `pnpm run check` | exit 0 |
| No-cost media parity | `pnpm run test:sync-replay -- /absolute/path/to/fixture.mp3` | host/listener/shared samples agree; proof video written |
| Service unit tests | `python -m unittest discover -s services/local-timing/tests` | exit 0 without loading or downloading an ML model |
| Service benchmark | `services/local-timing/bin/benchmark /absolute/path/to/manifest.json` | machine-readable report written to an ignored NVMe result directory |

## Suggested executor toolkit

- Use the `prototype` skill for Step 2's aligner bake-off; keep variants
  disposable until one passes the thresholds.
- Use the `tdd` skill when moving contracts into source (Steps 3, 5).
- Use the `diagnosing-bugs` skill for language-specific alignment failures.
- Run a structured `autoreview` before committing each slice.
- MLX/PyTorch inference must be validated on the Apple Silicon host itself.

## Scope

**In scope**:

- A reproducible benchmark manifest and scorer for **line-boundary error**
  against human-marked line times on saved songs (no audio, lyrics, URLs, or
  credentials in git).
- A native macOS alignment service under an isolated `services/local-timing/`
  boundary (own Python environment and lock; no browser or Node runtime
  dependency), running HTDemucs vocal separation + known-text forced
  alignment.
- A **version-2 line-timing artifact**: `{version: 2, mode:
  'local-line-alignment', durationSeconds, lines: [{lineIndex, start, end}]}`
  (exact field names decided in Step 3) — line index + seconds only, no lyric
  text — validated alongside and never replacing version-1
  `minimax-section-asr` artifacts.
- Server-side provider composition: local line alignment primary (when
  configured), MiniMax sections fallback, Atmospheric last — plus an
  **optional** Workers AI section-grade rung (Step 5b) behind operator
  configuration.
- Passing the minimum lyric/language context (language code, script choice,
  chosen lyric sheet) to the operator-owned service while never forwarding
  the MiniMax token.
- Warm single-worker bounded queue, dedupe, overload signaling, NVMe-only
  large writes, cleanup, authenticated loopback/tunnel operation, health
  reporting, `launchd` lifecycle.
- Line-aware display through the existing shared timeline seam, with honest
  UI copy per mode, and updates to the binding docs
  (`docs/section-timing.md`, `PRODUCT.md`, README privacy section).
- Unit, contract, no-cost replay, browser parity, overload, privacy, and
  operator verification.

**Out of scope**:

- Replacing paid MiniMax Music 3 generation or the lyricist.
- Requiring any second credential from an end user (operator-only secrets
  stay server-side and optional).
- Word-by-word karaoke animation. The artifact is line-level; within-line
  emphasis stays with the existing `src/lyrics/line-pacing.ts` heuristic.
- Persisting tokens, signed URLs, raw provider payloads, transcripts,
  prompts, or full lyric sheets after a request settles.
- Exposing the Python service directly to browsers or a public interface.
- Speaker diarization, subtitle export, generic transcription UI.
- Changing the section-mapping algorithm in `src/lyrics/lyric-sync.ts` — its
  incident regression tests must pass byte-identically.

## Git workflow

- Fetch `origin/main`, require a clean worktree, branch
  `advisor/007-line-alignment` from current main.
- Conventional commits (match `git log`): e.g.
  `feat(timing): add local line-alignment provider`,
  `test(timing): cover local queue overload`.
- Commit benchmark/contract, service, app integration, and documentation as
  separate reviewable slices.
- Do not push, deploy, open a PR, create a tunnel, or change hosted
  environment variables unless the operator explicitly authorizes it. The
  share worker deploys only via CI on merge to `main` or explicit operator
  instruction.

## Steps

### Step 1: Freeze a line-annotated, secret-free benchmark corpus

Create a manifest schema pointing at local audio plus local sidecars (never
copied into git; check in only the schema, a synthetic fixture, and scorer
tests). Each private sidecar records: language, script choice, the written
line sequence as **indexes only** (line count per section, not text),
human-marked start times for a sampled subset of lines (at least 8 lines per
song including first vocal line, one mid-chorus line, and the final line),
duration, and an `audiblyVerified` flag.

At least six 2–3 minute songs spanning: clear English pop; English/Hindi
code-switching; Gujarati native script; Hindi or Urdu native script; a sparse
intro with late vocal entry; dense instrumentation. Reuse saved recordings
and existing share-bucket songs before asking the operator to authorize any
paid generation.

Acceptance thresholds for the selected warm configuration on the M4/16 GB
host (separation + alignment combined):

- median wall time ≤ 25 s and p95 ≤ 45 s per song (Demucs adds real cost over
  the old 15/30 s section-only targets; measure, don't assume);
- median absolute line-start error ≤ 0.7 s and p95 ≤ 1.5 s on audibly
  verified sampled lines;
- line order strictly monotonic; no line mapped outside the media duration;
- degraded input (heavy instrumentation, hallucination-prone Gujarati) must
  yield a terminal low-confidence result, not a plausible-looking artifact;
- all model/cache/temp writes on the external NVMe.

**Verify**: scorer unit tests pass; running the benchmark twice (cold, warm)
produces reports containing every corpus row, aggregate latency/error,
rejection reasons, and no lyric text, URLs, tokens, or audio bytes.

### Step 2: Bake off aligners through one adapter; pick the smallest that passes

Benchmark through a common adapter, in this order:

1. **HTDemucs vocal separation -> `torchaudio.pipelines.MMS_FA` forced
   alignment** of the known line/word sequence (primary candidate; Hindi and
   Gujarati in-model). Score with and without separation to quantify the
   separation lever.
2. **Echogarden (Node) DTW alignment** on the same corpus — a passing result
   here collapses the Python boundary entirely; worth one bounded spike day.
3. **WhisperX-style Wav2Vec2 CTC alignment** with an explicit Hugging Face
   aligner model for Hindi; note Gujarati coverage gaps honestly.
4. **Baseline: MLX Whisper Turbo section decoding** (the 2026-08 prototype
   configuration) — not a line-level candidate; include one run so the report
   shows the improvement over the shipped MiniMax-equivalent quality.

Before adopting any model, **verify its license terms are compatible with
this deployment** (note: MMS model checkpoints are released by Meta under a
non-commercial license family — confirm the current terms from the model card
and record the finding in the ADR; if incompatible, WhisperX-with-HF-aligner
or Echogarden becomes primary). Record every candidate's numbers and the
rejection rationale in the benchmark report and ADR.

**Verify**: one manifest produces a side-by-side report; at least one
line-level candidate passes every Step 1 threshold on English and
code-switched songs AND degrades safely (terminal low-confidence, not wrong
timings) on the hardest Gujarati track. Otherwise STOP.

### Step 3: Define the version-2 line artifact, backward compatible

Extend `src/lyrics/lyric-sync.ts` additively:

- `normalizeLyricTiming` (or a sibling `normalizeLineTiming`) accepts the new
  `{version: 2, mode: 'local-line-alignment'}` shape with strictly monotonic
  non-overlapping line spans, clamped like version 1, while stored
  version-1 artifacts keep validating byte-identically.
- The shared timeline seam (`src/client/shared/lyric-timeline.ts`) prefers a
  valid line artifact and derives frames directly from line spans; with a
  section artifact it keeps today's behavior unchanged.
- Script mapping: the artifact carries **line indexes into the parsed sheet**
  (`parseLyricSheet` numbering), so native and romanized text both follow by
  index. The service aligns against whichever script the aligner's acoustic
  model expects; the index mapping back is Mini Mehfil's own code — design it
  in this step with tests for code-switched sheets where native and romanized
  line counts already agree by construction (`scriptSections` pairing).
- UI copy: line-timed mode reads a new honest string (proposal:
  `Lines follow measured timing`); section mode keeps
  `Lines follow MiniMax sections · timing is approximate`; pending/fallback
  copy unchanged. Update `docs/section-timing.md` and `PRODUCT.md` in the
  same commit — they are binding.
- The room protocol and share worker validate and persist the version-2
  artifact exactly as they do version 1 (same `lyricTiming` field; the
  normalizer discriminates by `version`/`mode`).

**Verify**: focused tests prove old artifacts still parse, new artifacts
round-trip host/room/share serialization, invalid line artifacts (overlap,
non-monotonic, out-of-duration, unknown mode) are rejected, and the three
2026-08-18 incident regression tests still pass unmodified. `pnpm run check`
passes.

### Step 4: Build the alignment service inside the Plan 007 boundary

`services/local-timing/` — isolated Python project, pinned interpreter and
model revisions, public interface smaller than its implementation:

- one authenticated analyze operation: input = audio source (validated HTTPS
  from an allowlist, or authenticated bounded upload), language code, script
  choice, line/word sequence; output = the normalized version-2 artifact or a
  discriminated low-confidence/terminal failure;
- one loopback-only health endpoint (version, ready/busy, numeric queue
  depth);
- pipeline per job: download to NVMe -> HTDemucs vocal stem -> forced-align
  known text -> derive line spans -> validate (monotonic, in-duration,
  anchor coverage) -> emit line indexes + seconds only -> delete temp files in
  `finally`;
- one warm model instance, one inference worker, FIFO queue capped at six,
  deterministic 429 with bounded `Retry-After` when full, idempotent dedupe
  per recording, short-lived cache of normalized artifacts only;
- structured privacy-safe logs (no lyric text, transcript, token, signed
  URL, payload);
- model-free logic (parsing, span derivation, queue, validation) split from
  model loading so Linux CI runs those tests with the standard library;
- single local run command plus a `launchd` example pinning all HF/torch/
  XDG/temp caches to the NVMe. Native inference stays outside Docker.

**Verify**: service unit tests pass without a model. On the Mac: warm once,
analyze the whole corpus, leave no temp audio, all large writes on NVMe. Ten
concurrent fixture requests: one runs, six queue FIFO, the rest get bounded
429s, duplicates never decode twice.

### Step 5: Compose providers on the server with explicit fallback rules

Add a provider interface beside `analyzeMiniMaxTiming` and a composition
layer in the `/api/analyze-timing` route (`src/server/index.ts:464`):

- local configured + ready/validated -> return the line artifact;
- local low-confidence/invalid/malformed -> MiniMax sections, within the
  browser's existing 2x180 s budget;
- local offline/auth-failed/queue-full after bounded wait -> MiniMax sections;
- no local configuration -> MiniMax only (today's behavior, byte-identical);
- cancellation/stale song -> suppress all results;
- retries are idempotent with bounded backoff — never duplicate local decodes.

The route may send exact lyrics/language to the configured operator-owned
service only; never the MiniMax token, prompt, idea, vibe, room data, or
share credentials. Authenticate server -> service with an operator secret that
never reaches the browser; service binds to loopback and is reached via an
authenticated outbound tunnel.

**Verify**: server contract tests cover every class above plus configuration
absence; serialized requests and logs contain none of the forbidden fields.

### Step 5b (optional, operator-flagged): Workers AI section-grade rung

Behind explicit configuration, add a Cloudflare Workers AI Whisper
(`@cf/openai/whisper-large-v3-turbo`) provider that produces a **version-1
section artifact** from its VTT segments, slotted between MiniMax and
Atmospheric (or replacing MiniMax when the operator prefers). It is ASR, so
derive sections by matching segment text against written section families
using the existing family vocabulary — reuse, do not fork,
`buildSectionTimeline`'s mapping. Skip this step entirely if time-boxed out;
record the decision in the ADR. **Never persist its transcript.**

**Verify**: with the flag off, no Workers AI call occurs (assert in tests);
with it on, a fixture VTT produces a valid version-1 artifact.

### Step 6: Prove playback and publication parity without paid generation

Extend `test/browser/sync-replay.spec.ts`'s no-cost pattern so the timing
response can come from the real local service over saved audio:

- private playback starts while alignment is pending;
- a late line artifact applies in place — no reload, seek, pause, or play;
- exactly one current line at any clock; forward/backward seeks stateless;
- share and room publication wait for ready/terminal and carry the version-2
  artifact; old untimed/section shares stay compatible;
- host, live listener, and standalone shared page agree at sampled clocks;
- local failure -> MiniMax fixture sections; double failure -> Atmospheric.

Record the proof video from the saved-audio path. No test reads a real token
or issues a paid request.

**Verify**: focused tests pass, then `pnpm run test:sync-replay` with the
service in the loop; inspect assertions and the privacy audit.

### Step 7: Deploy safely and run a controlled operator gate

Runbook before enabling anything: install/update/rollback the pinned
service; NVMe mount check with fail-closed startup; `launchd`
start/restart/readiness; authenticated outbound tunnel with no public
listener; credential rotation; queue/latency/fallback inspection; a
one-switch disable returning MiniMax to sole provider; recovery from sleep,
reboot, tunnel outage, model-download failure, full queue.

Enable local-primary on a **preview deployment only**. Use saved audio
first; any paid live test requires fresh explicit operator authorization.
Record provider choice, latency, line coverage, and subjective accuracy —
never credentials, URLs, lyric text, or payloads.

**Verify**: preview handles local-ready, fallback, full-queue, Mac-restart,
refresh, backward seek, listener reconnect, and shared playback. Production
stays off until the operator approves the recorded result.

### Step 8: Closeout gates and decision record

Update `README.md` (privacy disclosure of the optional operator path),
`PRODUCT.md`, `docs/section-timing.md` (rename/extend as the timing contract
now spans sections and lines), the service runbook, environment reference,
and an ADR covering: selected aligner + license verification, benchmark
numbers, trust boundaries, queue policy, fallback ladder, artifact modes,
retention rules, rollback switch, and the Workers AI rung decision.

**Verify**: `pnpm run check`, `pnpm run test:browser`,
`pnpm run test:sync-replay`, service unit + Mac integration tests, benchmark
thresholds, overload test, privacy scan, and structured autoreview all pass.
`git status` shows only planned files. Do not merge or enable production
from the executor session.

## Test plan

- Service (model-free): line-span derivation from aligner output; monotonic/
  overlap/duration validation; low-anchor and repetition rejection; FIFO
  order, queue cap, dedupe, cache TTL, cleanup; script-index mapping for
  code-switched sheets.
- Node contract (model after `test/server/timing-analysis.test.ts`): local
  and MiniMax adapters normalize to one discriminated contract; forbidden
  fields never cross the boundary; each fallback class exact; version-1
  artifacts unaffected.
- Lyric-sync (model after `test/lyrics/lyric-sync.test.ts`): version-2
  validation matrix; version-1 byte-compatibility; the three 2026-08-18
  incident regressions untouched and passing.
- Controller (model after `test/client/host/timing-analysis-controller.test.ts`):
  bounded queue-wait retry; cancel/replace suppression; share/room-safe
  settlement.
- Browser (model after `test/browser/sync-replay.spec.ts`): pending -> local
  line-timed; local fail -> MiniMax sections; both fail -> Atmospheric;
  overload; backward seek; listener reconnect; three-surface equality.

## Done criteria

- [ ] Line-annotated secret-free corpus and scorer exist; thresholds defined
      in Step 1 are met by the selected pipeline on the M4/16 GB host.
- [ ] Selected aligner's model license verified compatible and recorded.
- [ ] Version-2 line artifact validates alongside version-1; stored artifacts
      and the three incident regression tests unchanged.
- [ ] Mac service: warm model, FIFO cap 6, dedupe, bounded 429s, NVMe-only
      writes, cleanup proven, loopback + operator-secret auth only.
- [ ] No second end-user credential anywhere; MiniMax token never reaches the
      local service (asserted in tests).
- [ ] MiniMax sections remain the automatic fallback; Atmospheric remains the
      floor; playback/Save/publication timing behavior unchanged.
- [ ] Host, listener, and shared page agree at sampled clocks on the same
      version-2 artifact, forward and backward.
- [ ] Binding docs (`docs/section-timing.md`, `PRODUCT.md`, README privacy)
      updated in the same changes as the behavior.
- [ ] All commands in "Commands you will need" pass; autoreview clean.
- [ ] No production flag enabled without explicit operator approval.

## STOP conditions

Stop and report instead of improvising if:

- The drift check reveals a changed provider/artifact/playback contract, or
  the incident regression tests in `test/lyrics/lyric-sync.test.ts` fail for
  any reason other than an intentional, reviewed contract change.
- No line-level candidate meets the Step 1 thresholds, or every candidate
  with acceptable accuracy has an incompatible model license.
- Accurate alignment would require persisting or logging tokens, signed
  URLs, transcripts, prompts, or full lyric sheets after settlement.
- The service would need a browser-visible credential or a second end-user
  credential.
- Audio sources cannot be constrained against SSRF via allowlist or bounded
  authenticated upload.
- Separation + alignment latency cannot fit the browser's 2x180 s budget
  within the queue bound on the 16 GB host.
- The NVMe is unavailable and large writes would land on the internal disk.
- Script-index mapping proves unsound for real code-switched sheets (native
  and romanized line structures diverge beyond `scriptSections` pairing) —
  report with examples rather than shipping wrong line highlighting.
- Any verification fails twice after a reasonable correction.

## Maintenance notes

- The benchmark manifest and scored report are the regression contract for
  any future model/decoder upgrade; rerun before rollout.
- Queue capacity 6 derives from measured per-song latency and the 2x180 s
  browser budget; recompute from production p95 before raising it.
- The line artifact is deliberately text-free. If word-level karaoke is ever
  wanted, that is a version-3 artifact and a new plan — do not smuggle word
  spans into version 2.
- Signed MiniMax URL hostnames may change; update the service allowlist only
  from sanitized observed hostnames with an SSRF regression test.
- Reviewer focus: fallback must never duplicate expensive local work;
  sensitive inputs must not cross diagnostics or persistence; every surface
  keeps deriving state from one immutable artifact; the share worker deploy
  must land with (or before) any app change that emits version-2 artifacts.
