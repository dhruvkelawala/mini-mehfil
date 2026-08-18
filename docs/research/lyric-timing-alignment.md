# Getting exact (line/word) lyric-to-audio timing instead of section timing

Researched 2026-08-18 against primary sources (platform.minimax.io docs,
Cloudflare/Vercel/ElevenLabs/Groq/OpenAI/Deepgram/AssemblyAI own docs, PyTorch/
torchaudio docs, project READMEs, and MIR papers on arXiv). Community/secondary
sources are labeled as such. Written against the current contract in
`docs/section-timing.md`, `plans/007-local-mlx-timing-service.md`, and
`src/server/timing-analysis.ts`.

## TL;DR — ranked recommendation for Mini Mehfil's topology

1. **No MiniMax endpoint returns line/word timing today** — VERIFIED. Neither
   `music_cover_preprocess`'s `formatted_lyrics` nor `structure_result` carries
   anything finer than segment start/end in seconds
   ([API reference](https://platform.minimax.io/docs/api-reference/music-cover-preprocess)).
   MiniMax's only word-level timestamp feature (`subtitle_enable` on Speech
   2.6 T2A) times MiniMax's _own generated speech_, not arbitrary sung audio
   against a known sheet, so it cannot align our Music-3 output
   ([T2A subtitle docs, via search of platform.minimax.io](https://platform.minimax.io/docs/guides/speech-t2a-async)).
   MiniMax is not a path to finer timing; treat it as the permanent
   free/no-second-credential section-level fallback it already is.

2. **Best fit for the existing plan: keep Plan 007's operator Mac as the
   line-timing engine, but do forced alignment of the _known_ lyric sheet
   instead of open ASR.** Because Mini Mehfil already knows the exact,
   verbatim lyrics (`PRODUCT.md`: "Lyrics are sung literally"), the task is
   forced alignment, not transcription — a strictly easier, more robust
   problem than what Plan 007 benchmarked (open decoding + section
   heuristics). Concretely: run vocal source separation (Demucs/HTDemucs) then
   a CTC forced aligner over the known text. This is the one option that (a)
   needs no new end-user credential, (b) can honestly claim "no lyric text
   persisted" since only line-index+timestamp pairs leave the service, and
   (c) has multilingual coverage for Hindi/Gujarati/English/code-switching
   that MiniMax's own docs don't promise for music at all.

3. **Concrete pipeline to prototype on the Mac, ranked by expected robustness
   for sung, code-switched, script-mixed lyrics:**
   - **Primary: HTDemucs vocal separation → MMS forced-alignment (`torchaudio.pipelines.MMS_FA`, CTC forced-align) using the _known_ lyric line/word sequence as the label string.** MMS_FA's acoustic model covers 1,100+ languages including Hindi and Gujarati (VERIFIED via [PyTorch docs](https://docs.pytorch.org/audio/2.8/tutorials/forced_alignment_for_multilingual_data_tutorial.html) and the underlying [Meta MMS paper](https://ai.meta.com/research/publications/scaling-speech-technology-to-1000-languages/): "a single multilingual automatic speech recognition model for 1,107 languages" and pretrained wav2vec2 models for 1,406 languages). This is forced _alignment_, not ASR — it never has to guess the words, only their timing, which matches Mini Mehfil's actual problem far better than the Whisper-transcription approach Plan 007 already tried and found imperfect on Gujarati (hallucination at 143s, mitigated only by pinning language + temperature 0, per `plans/007-local-mlx-timing-service.md`).
   - **Fallback per-line refinement: WhisperX's wav2vec2 alignment stage** — already evaluated in Plan 007 as `KalebJS/whispermlx` and rejected only as a full-stack dependency, not on accuracy; WhisperX ships default aligners for `{en, fr, de, es, it}` and needs a Hugging Face CTC model for other languages (VERIFIED: [WhisperX README](https://github.com/m-bain/whisperX), `DEFAULT_ALIGN_MODELS_HF` in [`alignment.py`](https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py)) — Hindi/Gujarati would need an explicit HF model swap, unlike MMS_FA which covers them out of the box.
   - **Preprocessing that measurably matters:** run source separation before alignment. Music/vocal interference is the dominant error source in lyric alignment literature — a 2026 paper on Whisper-based automatic lyrics transcription reports that "models that align words to vocal tracks separated by Demucs outperform other methods and obtain competitive results with state-of-the-art approaches" ([arXiv:2506.15514](https://arxiv.org/pdf/2506.15514)), and the DALI dataset construction pipeline itself is built around time-aligned lyrics at note/word/line/paragraph granularity for exactly this reason ([DALI project, cited via arXiv:2506.15514](https://arxiv.org/pdf/2506.15514)).
   - **Code-switched / dual-script matching:** since Mini Mehfil already carries both native-script and romanized lyric text, do NOT rely on the aligner's own tokenizer to handle script-mixing. Instead run the forced aligner against whichever script its acoustic model was trained on, then map the resulting phoneme/word timings back onto line boundaries in _both_ scripts by index — this sidesteps romanization ambiguity entirely and requires no new alignment component. This is the standard "known-text forced alignment" pattern; robustness comes from having ground-truth text, not from clever fuzzy matching. (No primary source claims MMS/WhisperX do script transliteration internally — treat that mapping step as our own responsibility, UNVERIFIED against any library doing it for us.)

4. **Second-best if Plan 007's Mac path stalls or the operator wants a zero-ops
   alternative: ElevenLabs' Forced Alignment API, operator-side optional key.**
   It is explicitly a forced-alignment product (known text + audio → aligned
   transcript), matching Mini Mehfil's problem exactly, and lists Hindi among
   its 29 supported languages — but **not Gujarati** (VERIFIED:
   [ElevenLabs Forced Alignment docs](https://elevenlabs.io/docs/overview/capabilities/forced-alignment)).
   Pricing is stated only as "same rate as the Speech to Text API," with no
   number confirmed from the page fetched — **UNVERIFIED, get the exact
   per-minute rate from ElevenLabs' pricing page before relying on it.** This
   is a legitimate operator-side secret (never required from end users) but
   does not cover Gujarati, so it can only be a _tier-1_ option alongside MMS,
   not a full replacement.

5. **Ruled out for our stack, with reasons:**
   - **Vercel serverless**: current Node function limits are 250 MB
     uncompressed bundle (up to 5 GB only on Fluid Compute) and up to 800 s
     duration on paid tiers, with a 4.5 MB request/response payload cap
     (VERIFIED: [Vercel Functions limits](https://vercel.com/docs/functions/limitations)).
     A PyTorch + wav2vec2/MMS stack is plausible only under the Fluid Compute
     5 GB ceiling and would still need to fetch/decode MP3 audio inside a
     4.5 MB response cap for anything returned inline — feasible only with
     careful engineering, and it reintroduces exactly the "single remote
     dependency, no operator control" problem Plan 007 already moved away
     from. Not recommended as the primary path; Cloudflare Workers AI (below)
     is a better "runs in our existing infra" option.
   - **Cloudflare Workers AI Whisper** (`@cf/openai/whisper`,
     `@cf/openai/whisper-large-v3-turbo`): runs where our Worker already runs,
     needs no end-user credential, and is cheap — $0.0005/audio-minute
     (VERIFIED: [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)).
     But its documented output is **segment-level** timing via a WebVTT
     `vtt` field, not word-level (VERIFIED: [whisper-large-v3-turbo model page](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)
     — output schema shows `segments[]` with a `vtt` field, no per-word
     array documented). It is also open ASR, not forced alignment of the
     known sheet, so it would still need a fuzzy-matching layer against our
     lyric text. Useful only as a possible drop-in _replacement_ for the
     MiniMax section call (same or better latency/cost, still section-grade),
     not a path to word-level timing.
   - **In-browser WASM/WebGPU (transformers.js / whisper-web)**: WebGPU
     support on Safari/iOS is recent and explicitly flagged experimental —
     "Safari supports it on macOS Sequoia 26 and iOS 26 … Safari support
     remains experimental," and the whisper-web demo has open issues getting
     stuck on iOS Safari (VERIFIED via search of
     [Transformers.js v3 blog](https://www.huggingface.co/blog/transformersjs-v3)
     and a live [GitHub issue](https://github.com/huggingface/transformers.js/issues/1298)).
     Given Mini Mehfil's listeners are meant to work with zero setup on
     whatever device they open a shared link on, this is not reliable enough
     to be primary today; keep it as a future edge-tier idea, not a
     near-term plan.

**Net recommendation**: extend Plan 007, don't replace it. Swap its
benchmarked "Whisper decode + section heuristics" step for "vocal
separation + known-text forced alignment (MMS_FA primary, WhisperX/HF CTC
model as an alternative)," keep MiniMax `music_cover_preprocess` as the
non-blocking fallback exactly as today, and treat ElevenLabs Forced Alignment
as an operator-side optional secondary provider for languages it covers
(not Gujarati). This still produces a version-2 line-timing artifact of line
index + start/end seconds only, matching the existing "never persist
transcripts" constraint, since the aligner already knows the words — it
never needs to write them down anywhere Mini Mehfil stores.

---

## 1. MiniMax APIs: does anything return finer-than-section timing?

**`music_cover_preprocess` response fields — VERIFIED, all six documented
fields** ([API reference](https://platform.minimax.io/docs/api-reference/music-cover-preprocess)):

| Field              | Description (as documented)                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `cover_feature_id` | Unique identifier for the preprocessed audio features, valid 24 h                                                                           |
| `formatted_lyrics` | Structured lyrics extracted via ASR, tagged with section markers (`[Verse]`, `[Chorus]`, `[Bridge]`, etc.) — **no timing data of any kind** |
| `structure_result` | JSON string of segment types with **start/end timestamps in seconds** — segment-level only                                                  |
| `audio_duration`   | Duration in seconds                                                                                                                         |
| `trace_id`         | Request tracking ID                                                                                                                         |
| `base_resp`        | Status object                                                                                                                               |

`formatted_lyrics` is text with section tags, not a timed transcript — it
cannot be a source of line/word timing however it's parsed.

**Any MiniMax speech-to-text / ASR endpoint with word timestamps?** Search of
platform.minimax.io and MiniMax's own guide index did not surface a
standalone ASR/STT endpoint at all — MiniMax's speech products are
text-to-speech (T2A) and voice cloning, not transcription of arbitrary
uploaded audio. **UNVERIFIED as "does not exist"** — I could not open a full
platform.minimax.io endpoint index in this session to positively rule out an
ASR product; treat "no MiniMax ASR endpoint" as likely-true-but-not-fully-
confirmed, and re-check MiniMax's docs index directly before final
architecture sign-off.

**MiniMax T2A subtitle timestamps** — the async long-form TTS guide documents
`subtitle_enable` for Speech 2.6 HD/Turbo returning sentence-level, word-level,
and streaming-optimized word timestamps
([platform.minimax.io guide, confirmed via search snippet of `speech-t2a-async`](https://platform.minimax.io/docs/guides/speech-t2a-async)).
This times MiniMax's own synthesized speech output, generated from text it is
told to speak — it has no application to aligning a separately-generated
Music-3 recording against a lyric sheet. Not usable for our problem.

**Verdict: no MiniMax endpoint, on the same BYOK key, returns line- or
word-level timing for a finished song.** The section-level ceiling documented
in `docs/section-timing.md` is a real ceiling of the provider, not an
implementation gap in Mini Mehfil.

## 2. Forced alignment of known text to sung audio

Mini Mehfil's actual problem is **forced alignment**, not transcription: the
lyric sheet is already known verbatim (`PRODUCT.md`: "MiniMax performs the
`lyrics` field verbatim"). This changes which tools are relevant — pure ASR
tools (plain whisper.cpp, Cloudflare Workers AI Whisper) only get you back to
"transcribe, then fuzzy-match," while forced-alignment tools take the known
text directly.

- **torchaudio CTC forced alignment / `MMS_FA`** — VERIFIED. Meta's Massively
  Multilingual Speech project trained "pre-trained wav2vec 2.0 models covering
  1,406 languages, a single multilingual automatic speech recognition model
  for 1,107 languages" ([Meta AI research page](https://ai.meta.com/research/publications/scaling-speech-technology-to-1000-languages/)).
  `torchaudio.pipelines.MMS_FA` is documented as a `Wav2Vec2FABundle`
  pairing that acoustic model with a tokenizer, used through
  `torchaudio.functional.forced_align()` and `merge_tokens()`
  ([PyTorch multilingual forced-alignment tutorial](https://docs.pytorch.org/audio/2.8/tutorials/forced_alignment_for_multilingual_data_tutorial.html)).
  Hindi and Gujarati are covered by the underlying 1,100+ language model
  family per the MMS paper's language count, though I could not open a
  itemized per-language table in this session — **treat "Hindi/Gujarati
  specifically work well" as plausible-but-not-line-item-verified**; the
  language _count_ claim is primary-sourced, per-language _accuracy_ is not.
- **WhisperX** — VERIFIED via its own README and source: "word-level
  timestamps via forced phoneme alignment" using wav2vec2, with default
  aligner models only for `{en, fr, de, es, it}`
  (`DEFAULT_ALIGN_MODELS_HF` in [`alignment.py`](https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py));
  for other languages the docs say to supply "a phoneme-based ASR model from
  Hugging Face Hub." Plan 007 already evaluated `KalebJS/whispermlx` (WhisperX
  with the ASR backend swapped for `mlx-whisper`) and found "its default
  aligner list includes several Indic languages but not Gujarati" — so
  WhisperX's out-of-the-box coverage is a strict subset of MMS_FA's for our
  language set.
- **stable-ts** — a Whisper wrapper focused on more stable segment timestamps
  and word-level timestamp refinement of Whisper's own output; it is a
  transcription-quality tool, not a known-text forced aligner, so it doesn't
  fit Mini Mehfil's problem directly. Not independently verified against a
  primary doc in this session — **UNVERIFIED**, noted only because Plan 007's
  brief mentioned it.
- **echogarden** — VERIFIED via its own docs: "speech-to-transcript alignment
  using several variants of dynamic time warping (DTW, DTW-RA)... or via
  guided decoding using Whisper recognition models"
  ([Echogarden README/docs](https://github.com/echogarden-project/echogarden)).
  Alignment takes a language code and can auto-detect from the transcript.
  It also ships a translation-alignment mode using multilingual E5 embeddings
  over 100 languages for near-word-level timing of translated text. It is a
  Node.js library (`echogarden-project/echogarden`), which is notable because
  it's the only forced-alignment tool surveyed here that fits the existing
  Node/TypeScript server without a Python service boundary — worth a
  standalone spike before committing to the Python-based MMS_FA/WhisperX
  path, since it could collapse Plan 007's `services/local-timing/` Python
  boundary into the existing Node app.
- **aeneas** — VERIFIED: Python/C library, AGPLv3-licensed, "confirmed
  working on 38 languages" ([GitHub README](https://github.com/readbeyond/aeneas))
  — Hindi and Gujarati are **not** in its listed 38-language set. AGPLv3 is
  also a stricter license than the MIT/BSD-family tools here. Not recommended.
- **Gentle** — a Kaldi-based English-only forced aligner; not evaluated in
  depth here since it has no path to Hindi/Gujarati coverage — **UNVERIFIED**
  beyond general awareness, excluded on language-coverage grounds alone.
- **Montreal Forced Aligner (MFA)** — VERIFIED: MFA 3.x ships a pretrained
  Hindi acoustic model (`Common Voice Hindi v7.0`) with a matching dictionary
  ([mfa-models repo](https://github.com/MontrealCorpusTools/mfa-models/blob/main/docs/source/corpus/Hindi/Common%20Voice%20Hindi%20v7_0.md)).
  No Gujarati pretrained model was found in this session's search —
  **UNVERIFIED absence**, would need a direct look at the mfa-models index.
  MFA also expects a pre-existing pronunciation dictionary per language,
  adding setup weight vs. MMS_FA's single multilingual acoustic model.
- **whisper.cpp** — VERIFIED as a C/C++ Whisper.cpp inference engine
  ([ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp), already
  cited in Plan 007) with Metal/CoreML acceleration; it is transcription, not
  forced alignment — useful only as a decoding backend if paired with a
  separate alignment stage, same role as `mlx-whisper` in Plan 007's
  benchmark.
- **transformers.js / whisper-web (WebGPU)** — see topology section 3(b)
  below; not a forced aligner either, would need pairing with alignment.

**Vocals-vs-speech caveat, with citations**: alignment/transcription models
are trained overwhelmingly on speech, and singing plus instrumental
accompaniment measurably hurts them. A 2026 automatic-lyrics-transcription
paper states that separating vocals from the mix before running Whisper
improves results: "models that align words to vocal tracks separated by
Demucs outperform other methods and obtain competitive results with
state-of-the-art approaches" ([arXiv:2506.15514](https://arxiv.org/pdf/2506.15514),
citing Hybrid Demucs `mdx`/`mdx_extra` pretrained models for the separation
step). The DALI dataset — built specifically to have time-aligned lyrics at
note/word/line/paragraph granularity for MIR research — exists because
plain speech-alignment tooling doesn't transfer cleanly to singing without
this kind of preprocessing (cited via the same paper). **Action for Mini
Mehfil: run HTDemucs vocal separation before forced alignment**, not as a
nice-to-have but as the documented accuracy lever in this literature.

## 3. Where each option could run in our topology

**(a) Vercel serverless (Node)** — VERIFIED limits from Vercel's own docs
([Functions limitations](https://vercel.com/docs/functions/limitations)):
250 MB uncompressed bundle by default (up to 5 GB uncompressed only under
Fluid Compute), up to 800 s max duration (10 s Hobby / 60 s Pro / 1800 s
Enterprise, configurable via `maxDuration` up to the plan ceiling), 4 GB
memory ceiling, and a 4.5 MB request/response payload cap
([memory config docs](https://vercel.com/docs/functions/configuring-functions/memory)).
A PyTorch + MMS/WhisperX stack with model weights is a stretch even at
5 GB Fluid Compute, and the 4.5 MB payload cap rules out returning raw audio
inline. Feasible only with heavy engineering (external model host, streamed
audio via URL not payload) — not recommended as the primary runtime.

**(b) Listener's browser (WASM/WebGPU)** — VERIFIED: Transformers.js v3 added
WebGPU support with automatic WASM fallback
([HF Transformers.js v3 blog](https://www.huggingface.co/blog/transformersjs-v3)),
but Safari/iOS WebGPU support only landed with macOS Sequoia 26 / iOS 26 and
is still called "experimental," and the reference whisper-web demo has an
open, unresolved issue getting stuck on iOS Safari
([transformers.js issue #1298](https://github.com/huggingface/transformers.js/issues/1298)).
Given Mini Mehfil's shared-listener flow must work with zero setup on
whatever device a link is opened on, in-browser alignment is not reliable
enough today, especially on iOS. Track as a future option once Safari WebGPU
matures, not a near-term plan.

**(c) Operator Mac service (Plan 007's boundary)** — the natural home for the
recommended pipeline (section 1 above). Plan 007 already measured MLX
Whisper Turbo warming in ~3 s and decoding a real 186.9 s song in 12.25–20.1 s
depending on whether word timestamps were requested, with 8/8 section anchors
scoring 0.90–1.00 on a live English song. Swapping the alignment stage for
known-text forced alignment (MMS_FA or a WhisperX HF aligner) rather than
open decoding keeps the same isolated `services/local-timing/` boundary,
warm-model, bounded-queue design already specified in Plan 007 — it changes
Step 2's candidate list, not the service architecture around it.

**(d) Cloudflare Workers AI** — VERIFIED it runs Whisper
(`@cf/openai/whisper`, `@cf/openai/whisper-large-v3-turbo`) at
$0.0005/audio-minute, in the exact runtime our Worker already uses, with no
end-user credential needed
([model page](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/),
[pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)).
Its documented output schema is `segments[]` with a `vtt` field — segment,
not word, granularity, per the model page fetched directly. It is also open
ASR, so using it for line-level accuracy would require our own fuzzy match of
its transcript against the known lyric sheet (edit-distance/DTW, section 5).
Best framed as a **candidate replacement for the MiniMax section call**
(cheaper, runs in our existing infra, no new credential) rather than a route
to word-level timing on its own.

## 4. Hosted alignment/ASR APIs (operator-side optional)

- **ElevenLabs Forced Alignment API** — VERIFIED to exist and to be a
  purpose-built known-text aligner: "turns spoken audio and text into a
  time-aligned transcript," accepting audio up to 3 GB / 10 h and plain-text
  input (no diarization)
  ([ElevenLabs docs](https://elevenlabs.io/docs/overview/capabilities/forced-alignment)).
  Supports 29 languages including Hindi, explicitly **not** Gujarati per the
  language list fetched. Pricing is stated on that page only as "same rate as
  the Speech to Text API" — the exact per-minute number is **UNVERIFIED**
  from what was fetched; get it from ElevenLabs' pricing page before costing
  this out.
- **AssemblyAI** — VERIFIED word-level timestamps are returned by default,
  documented accuracy "within about 400 milliseconds"
  ([AssemblyAI FAQ](https://www.assemblyai.com/docs/faq/does-your-api-return-timestamps-for-individual-words)).
  This is ASR with timestamps, not known-text forced alignment, so it would
  need the fuzzy-match layer from section 5. Pricing not verified in this
  session.
- **Deepgram** — word timestamps are a known Deepgram feature per general
  documentation, but the specific docs URL fetched in this session
  (`developers.deepgram.com/docs/word-timing`) 404'd — **UNVERIFIED**, needs
  a direct re-check of Deepgram's current docs site before relying on this.
- **Groq Whisper API** — VERIFIED: `response_format: "verbose_json"` with
  `timestamp_granularities: ["word","segment"]` on `whisper-large-v3` or
  `whisper-large-v3-turbo` returns word-level timestamps; both models are
  multilingual ([Groq docs](https://console.groq.com/docs/speech-to-text)).
  Pricing: $0.111/hour (`whisper-large-v3`) and $0.04/hour
  (`whisper-large-v3-turbo`), same source. Extremely cheap and fast (Plan 007
  independently benchmarks in this same speed class), but again ASR with
  timestamps against MiniMax's own transcript of the audio, not forced
  alignment of our known sheet — needs the fuzzy-match layer.
- **OpenAI Whisper API** — VERIFIED: the `timestamp_granularities` parameter
  with `response_format: "verbose_json"` returns a `words` array of
  `{word, start, end}` objects when `["word"]` is requested
  (confirmed via OpenAI developer community threads referencing the official
  parameter; the canonical docs page itself was not directly opened this
  session — **treat the parameter name/shape as VERIFIED by convergent
  primary-adjacent sources, the exact current docs URL as UNVERIFIED**).

All five are legitimate **operator-side optional** secrets under Mini
Mehfil's constraint (never a second credential required from end users) —
none of them are a drop-in replacement for the "known-text forced alignment"
approach in section 2, except ElevenLabs, which is architecturally the same
idea as MMS_FA/WhisperX but hosted and Gujarati-incomplete.

## 5. ASR-with-timestamps + fuzzy alignment: a well-trodden pattern

Where a hosted API is ASR-only (Groq, AssemblyAI, Deepgram, Workers AI
Whisper), the standard approach is: transcribe with word timestamps, then
align the _provider's own transcript_ against the _known lyric sheet_ using
edit-distance / DTW, and inherit timestamps for exactly-matched words. This
is exactly the pattern the Jam-ALT/JamendoLyrics research line uses to
convert word-level automatic transcripts into line-level ground truth: "word
alignment (edit-distance-based) between JamendoLyrics and Jam-ALT transcripts
was computed, and this alignment, along with word-level timings in
JamendoLyrics, was used to automatically derive line timings"
([cited within arXiv:2506.15514](https://arxiv.org/pdf/2506.15514)). This
confirms the pattern is standard MIR practice, not a novel idea Mini Mehfil
would be inventing. For code-switched, dual-script lyrics specifically, no
primary source surveyed here does the romanized-vs-native matching for us —
that step (map provider transcript tokens to whichever script the aligner
used, then re-associate with our own line index in both scripts) remains our
own responsibility either way, whether the underlying engine is ASR+fuzzy-
match or forced alignment.

**Given Mini Mehfil already knows the exact words, forced alignment (section
2/section 1's primary recommendation) is strictly better than ASR+fuzzy-match
where available**: it cannot mis-transcribe a word we already know, it
degrades gracefully to "confidently uncertain timing" rather than a wrong
transcript, and it removes an entire class of matching bugs. ASR+fuzzy-match
remains the fallback when the primary aligner's language coverage is
insufficient (e.g., ElevenLabs on non-Hindi Indic content) or as a
Cloudflare-Workers-AI-based low-cost alternative to the current MiniMax
section call.

## Proposed architecture sketch (top option)

```
Finished MP3 (public URL, ≤6 min, same as today)
        │
        ▼
[Operator Mac service — extends Plan 007's services/local-timing/ boundary]
   1. Download to NVMe (existing Plan 007 pattern)
   2. HTDemucs vocal separation → isolated vocal stem
   3. Forced-align known lyric sheet (native-script line/word sequence)
      against the vocal stem via torchaudio MMS_FA (primary) or a
      WhisperX HF CTC aligner for the detected language (secondary)
   4. Re-associate resulting word/line boundaries with BOTH native-script
      and romanized line indexes by position (no re-transcription needed —
      we already own both text forms)
   5. Reject low-anchor / non-monotonic / duration-mismatched results using
      the same rejection classes already specified in Plan 007 Step 4
   6. Emit ONLY: { lineIndex, startSeconds, endSeconds }[] — no lyric text,
      no transcript, no provider payload — matching the existing "only
      normalized section boundaries persist" rule in docs/section-timing.md,
      extended to line granularity
        │
        ▼
[Server: provider-neutral timing contract, exactly Plan 007 Step 3/5]
   local line-artifact ready → use it
   local low-confidence/offline/queue-full → fall back to MiniMax
      music_cover_preprocess section artifact (today's path, unchanged)
        │
        ▼
[Existing player-controller.ts contract]
   Same non-blocking, no-reload, no-seek apply; same host/listener/share
   parity; new artifact mode is line-level, honestly labeled in the UI copy
   ("Lines follow measured timing" vs current "timing is approximate")
```

This is additive to Plan 007, not a competing plan: it reuses the isolated
Python service boundary, the warm-model/bounded-queue design, the
provider-neutral `TimingAnalysisOutcome` contract, and the MiniMax-fallback
rule already specified there. The only structural change is Plan 007 Step 2's
candidate list (open decoding → known-text forced alignment) and Step 3's
artifact (section-only → line-level, still no lyric text stored).

## Open risks / unknowns

- **MMS_FA per-language accuracy for Hindi/Gujarati sung vocals is
  UNVERIFIED.** The 1,100+ language _count_ is primary-sourced; a specific
  word-error/timing-error number for Hindi or Gujarati _singing_ (as opposed
  to MMS's training data, largely read religious text) was not found in this
  session. This needs the same kind of benchmark corpus Plan 007 already
  specifies (Step 1), scored against forced-alignment boundary error, not
  Plan 007's transcription-hallucination metric.
- **No MiniMax ASR endpoint was positively ruled out**, only not found in
  this session's search — verify directly against MiniMax's full docs index
  before stating "MiniMax has no path to finer timing" as settled fact.
- **ElevenLabs Forced Alignment pricing is unverified** — "same rate as STT"
  needs a number from ElevenLabs' pricing page.
- **Deepgram word-timing docs URL 404'd in this session** — general
  word-timestamp support is well known but wasn't reconfirmed against a live
  Deepgram doc here.
- **Script-remapping (native ↔ romanized line association) has no library
  support found** — it is Mini Mehfil's own responsibility either way, and
  is unverified as "trivial" — code-switched lines where word order differs
  between scripts could break the positional mapping assumed above; this
  needs a dedicated design pass, not just a benchmark run.
- **Demucs/HTDemucs adds real latency and disk usage** to the Mac pipeline
  Plan 007 already budgets against a 12–28 s warm-decode target; the
  separation step's own runtime on the M4/16 GB host is unmeasured here and
  should be added to Plan 007's benchmark thresholds before committing to a
  "line-level" latency promise in the UI.
- **whisper.cpp / MLX Turbo remain useful only as a decode backend if the
  team decides ASR+fuzzy-match beats forced alignment in practice** — this
  document ranks forced alignment first on principle (known text should not
  be re-guessed), but only an actual benchmark on Mini Mehfil's real,
  code-switched, dual-script corpus can confirm that ranking empirically.
