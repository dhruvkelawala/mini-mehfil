# Getting native-language vocals out of MiniMax Music 3.0 (`music_generation`)

Researched 2026-08-14 against MiniMax primary sources (platform.minimax.io docs, minimax.io blog/news, MiniMax's own GitHub/Hugging Face/Replicate pages), with community sources clearly labeled as secondary.

> Historical record. References to `lyricist.mjs` describe the pre-migration
> layout; the lyricist now lives at `src/server/lyricist.ts`.

## What Mini Mehfil should change (actionable summary)

Relative to the current lyricist system prompt in `/Users/sumo-deus/minimax-mehfil/lyricist.mjs`:

1. **Keep native script as the sung `lyrics`.** No official MiniMax statement mandates a script, but MiniMax's own demos feed Chinese lyrics in hanzi (never pinyin), and the strongest community evidence for Indic vocals (Suno/Udio, secondary) says proper native script "jumps output quality up a full tier" vs romanized. Current behavior is right — keep it.
2. **Raise the character budget.** The real limit for direct `music-3.0` generation is **lyrics 1–3500 chars** (prompt 0–2000). The "10–1000" figure is the **music-cover / `cover_feature_id` mode limit only** — the contradiction noted in `lyricist.mjs` (lines 21–24) is resolved, not a discrepancy. `LYRICS_MAX_CHARS = 3000` is safely under the true 3500 cap; the ~900-char target can be raised (a 3–5 min song supports far more), though shorter lyrics are a stylistic choice, not an API constraint.
3. **Restructure the production prompt as a Structured Caption.** MiniMax officially recommends three ordered sections: Global Metadata (genre, subgenre, **BPM, key**, emotional progression, production profile) -> Vocal Details (**gender, timbre, performance style**, harmonies, effects) -> Arrangement (instruments per section, groove, textures). MiniMax's Replicate guidance: exact BPM + key "matches 99%+ of the time." The prompt should explicitly name the language and regional style (e.g. "Gujarati garba, dhol and dandiya claps, female folk vocal") — language naming is not officially documented as a control, but it is the only channel besides the lyrics script for signaling language, and MiniMax's caption schema explicitly covers vocal delivery.
4. **Keep English section tags — but stick to the official 14.** The API reference for music-3.0 lists exactly: `[Intro] [Verse] [Pre Chorus] [Chorus] [Interlude] [Bridge] [Outro] [Post Chorus] [Transition] [Break] [Hook] [Build Up] [Inst] [Solo]`. Note: **`[Pre-Chorus]` (hyphenated) is not in the API list** — the current lyricist prompt uses `[Pre-Chorus]`; switch to `[Pre Chorus]` (the Music-3 open-weights README uses hyphens, so both likely tokenize fine, but the hosted-API doc spells it with a space).
5. **Add line/phrasing rules to the lyricist prompt:** short lines (~2–4 lines per section per MiniMax's Replicate guide; 4–8 words per line per secondary guides), `\n` between lines, `\n\n` for pauses between sections, and parenthetical directions like `(Ooh, yeah)` / `(dhol break)` for ad-libs and performance cues — officially documented on MiniMax's Replicate pages. Verbatim chorus repetition (current behavior) is consistent with all guidance; no source contradicts it.
6. **Set expectations for Indic accuracy.** MiniMax officially says only "English and Mandarin Chinese have the strongest support. Other languages work but with less consistent pronunciation." No Indic language is mentioned in any primary source. Gujarati/Hindi/Tamil output quality is undocumented territory; regenerate-and-pick is a legitimate strategy (no `seed` param exists on the hosted API to pin variation anyway).

---

## 1. Script choice: native script vs romanized in `lyrics`

**Official position: none.** Neither the [Music Generation API reference](https://platform.minimax.io/docs/api-reference/music-generation) nor the [music generation guide](https://platform.minimax.io/docs/guides/music-generation) says anything about lyric language, script, transliteration, or auto-detection. There is no `language` parameter; the model infers language from the lyrics text itself.

**Official behavior by example (primary, indirect):** The [MiniMax Music 3.0 blog](https://www.minimax.io/blog/minimax-music-3-0-next-generation-open-weights-production-ready-versatile-music-model) and the [Hugging Face model card](https://huggingface.co/MiniMaxAI/MiniMax-Music3) show demo songs with Chinese lyrics written in **hanzi (native script), never pinyin**, alongside English demos in Latin script. MiniMax's own multilingual usage is always native-script.

**Community evidence (secondary, adjacent models):** A Hindi/Urdu producer's write-up on Suno/Udio ([abhishekchaudhary.com](https://abhishekchaudhary.com/blog/suno-udio-hindi-songwriters-producer-view)) reports that transliterating lyrics "properly into Hindi or Urdu script" moves output "up a full tier," and that romanized/English-script inputs produce "unusable Hindi output." This is about Suno/Udio, not MiniMax — but it's the best available evidence on the native-vs-romanized question for Indic vocals, and it aligns with MiniMax's own native-script demo practice. The same source cautions that some Indic short-vowel pronunciation failures are training-data limits "not fixable with prompt engineering."

**Verdict:** Keep sending native script (ગુજરાતી / देवनागरी / தமிழ்) as the sung `lyrics`; keep romanized text as display-only. This is the current `lyricist.mjs` behavior.

## 2. Prompt phrasing that improves vocal language/accent

**Official: the Structured Caption (Music 3.0's designed prompt format).** From the [Music 3.0 blog](https://www.minimax.io/blog/minimax-music-3-0-next-generation-open-weights-production-ready-versatile-music-model), [HF card](https://huggingface.co/MiniMaxAI/MiniMax-Music3), and [GitHub README](https://github.com/MiniMax-AI/MiniMax-Music3), the recommended prompt has three sections:

- **Global Metadata** — "genre, subgenre, BPM, key, scale, emotional progression, listening scenario, and production profile"
- **Vocal Details** — "vocal gender, timbre, performance style, harmony, backing vocals, and vocal effects"
- **Arrangement** — "primary and secondary instruments, section-level instrument evolution, groove, bass, percussion, textures, and spatial effects"

Official example prompt (HF card, verbatim):

> "Genre: acoustic pop. BPM: 96. Key: C major. Warm and intimate, building gently into the chorus. Vocals: soft female lead, close and breathy, light stacked harmonies in the chorus. Arrangement: fingerpicked guitar and soft piano; brushed drums and upright bass enter in the chorus."

Official example from the [platform guide](https://platform.minimax.io/docs/guides/music-generation):

> "A modern melodic trap and dark R&B track featuring a male vocalist with heavy autotune. The production is driven by a deep bouncy 808 sub-bass, fast rolling triplet hi-hats, and moody ambient synths."

**Official (MiniMax's Replicate org pages, [music-2.5](https://replicate.com/minimax/music-2.5) / [music-2.6](https://replicate.com/minimax/music-2.6)):** recommended prompt structure "Key, BPM, Genre, Mood/Emotion, Vocal description, Key instruments, Production style"; "Specify exact BPM and key in the prompt and the output matches 99%+ of the time"; "describe vocal characteristics" including "gender, timbre, delivery style, and effects." Example prompts: "E minor, 90 BPM, acoustic guitar ballad, male vocal, emotional"; "C major, 120 BPM, bright pop, female vocal."

**On naming the language / "native pronunciation" in the prompt: no official evidence either way.** No MiniMax source shows a prompt that names a language, and none claims accent control via prompt. The Music 3.0 guide does list "control over melody, **pronunciation**, breathing, and layered harmonies" as a 3.0 capability ([platform guide](https://platform.minimax.io/docs/guides/music-generation)), but gives no mechanism. Naming the language, regional genre (garba, filmi, Carnatic-fusion, bhangra), and region-specific instruments (dhol, dholak, harmonium, nadaswaram, mridangam, bansuri) is a reasonable inference from the caption schema ("genre, subgenre… instruments") — treat it as unvalidated best practice, not documented behavior. MiniMax also ships an official prompt-rewriting skill, `music-caption-rewriter` ([GitHub README](https://github.com/MiniMax-AI/MiniMax-Music3)), that expands a brief description + tagged lyrics into a full Structured Caption — worth mirroring in the lyricist prompt.

**Secondary ([Ambience AI prompt guide](https://www.ambienceai.com/tutorials/minimax-music-prompting-guide)):** be specific ("Dark melodic techno, pulsing bassline, atmospheric pads" beats "electronic music"); avoid contradictory descriptors; keep the prompt's emotional tone consistent with the lyrics.

## 3. Supported vocal languages

**There is no official language list for music-3.0.** Checked: [API reference](https://platform.minimax.io/docs/api-reference/music-generation), [guide](https://platform.minimax.io/docs/guides/music-generation), [3.0 blog](https://www.minimax.io/blog/minimax-music-3-0-next-generation-open-weights-production-ready-versatile-music-model), [Music 2.0 news post](https://www.minimax.io/news/minimax-music-20), [HF card](https://huggingface.co/MiniMaxAI/MiniMax-Music3), [GitHub](https://github.com/MiniMax-AI/MiniMax-Music3). None lists languages; official demos cover only Chinese and English.

**The closest first-party statement** is on MiniMax's own Replicate model pages ([music-2.5](https://replicate.com/minimax/music-2.5), [music-2.6](https://replicate.com/minimax/music-2.6)):

> "English and Mandarin Chinese have the strongest support. Other languages work but with less consistent pronunciation."

**"40+ languages" is third-party marketing**, appearing on reseller pages ([eachlabs](https://www.eachlabs.ai/minimax/minimax-music/minimax-music-v2), [invideo](https://invideo.io/ai-models/minimax-ai/)), not on any MiniMax-owned page — do not treat it as official. (MiniMax's *speech/TTS* products document large language lists including Hindi-accented English, but that documentation does not cover the music models.)

**Indic languages (Gujarati, Hindi, Tamil) are not mentioned in any primary source.** They fall in the "work but less consistent" bucket. Expect variance; generate multiple takes.

## 4. Lyric formatting: tags, phrasing, and the character-limit contradiction

**Official tag list — exactly 14 for music-3.0** ([API reference](https://platform.minimax.io/docs/api-reference/music-generation)):

`[Intro]`, `[Verse]`, `[Pre Chorus]`, `[Chorus]`, `[Interlude]`, `[Bridge]`, `[Outro]`, `[Post Chorus]`, `[Transition]`, `[Break]`, `[Hook]`, `[Build Up]`, `[Inst]`, `[Solo]`

(The community "14 tags" claim, e.g. [Ambience AI](https://www.ambienceai.com/tutorials/minimax-music-prompting-guide), matches this official list. The open-weights [HF card](https://huggingface.co/MiniMaxAI/MiniMax-Music3) uses hyphenated/alternate spellings — `[Pre-Chorus]`, `[Post-Chorus]`, `[Instrumental]` — and shows tags working in lowercase too, so the parser is evidently lenient; but for the hosted API, match the API-reference spellings. The separate [Lyrics Generation API](https://platform.minimax.io/docs/api-reference/lyrics-generation) emits a slightly different set including `[Drop]`/`[Breakdown]`, which music_generation's own doc does not list.)

**Official formatting guidance** (MiniMax Replicate pages, [music-2.5](https://replicate.com/minimax/music-2.5)/[2.6](https://replicate.com/minimax/music-2.6)):
- "Use `\n` to separate lines and `\n\n` to add pauses between sections."
- "Keep each lyric section to 2–4 lines for cleaner melodies."
- "Parenthetical text like `(Ooh, yeah)` or `(Guitar solo - slow, mournful)` works for backing vocals, ad-libs, and performance directions."

**Secondary formatting guidance** ([Ambience AI](https://www.ambienceai.com/tutorials/minimax-music-prompting-guide)): "Short lines of 4 to 8 words work best" for singability. No source gives syllable counts or explicit chorus-repetition rules; repeating the chorus verbatim (current lyricist behavior) is standard practice and consistent with MiniMax's structure-tag design.

**Character limit — contradiction resolved.** The [music-3.0 API reference](https://platform.minimax.io/docs/api-reference/music-generation) specifies, per mode:
- **Direct generation (music-3.0/2.6, vocal): `lyrics` required, 1–3500 characters.** (`prompt` 0–2000 optional with lyrics; 1–2000 required for instrumental/cover.)
- **Cover mode with `cover_feature_id` (music-cover): lyrics 10–1000 characters.**

So "10–1000" is the *cover-workflow* limit and "~3000/3500" is the *direct-generation* limit — different modes, not conflicting docs. The comment in `lyricist.mjs` (line 21) can be corrected: for Mini Mehfil's direct generation, the ceiling is 3500; `LYRICS_MAX_CHARS = 3000` is a safe margin. (Historic note: 10–3000 was the Music-2.0-era limit per [fal's v2 page](https://fal.ai/models/fal-ai/minimax-music/v2), which also capped prompts at 300 chars — both were raised for 2.5+.)

## 5. Other parameters affecting vocals

Documented `music_generation` parameters ([API reference](https://platform.minimax.io/docs/api-reference/music-generation)) beyond model/prompt/lyrics/audio_setting/output_format:

- **`lyrics_optimizer`** (bool, music-3.0/2.6 + free variants): auto-generates lyrics from the prompt when `lyrics` is empty. Relevant if you ever want MiniMax to write lyrics — but for Indic control, keep writing lyrics yourself.
- **`is_instrumental`** (bool): no-vocals mode; lyrics not required.
- **`stream`** (bool): streaming; forces `hex` output.
- **Cover/reference inputs** — `audio_url` / `audio_base64` (reference audio, 6 s–6 min, ≤50 MB) or `cover_feature_id` (from the Music Cover Preprocess API, valid 24 h; enables changed-lyrics covers, lyrics 10–1000 chars, and if lyrics omitted they're "automatically extracted from the reference audio via ASR"). **This is the only vocal-identity/reference mechanism** — there is no voice-clone or speaker parameter on music_generation. A cover of a real Gujarati/Tamil recording is a potential path to authentic pronunciation, at obvious rights cost.
- **No `seed` on the hosted API.** The open-weights release supports `seed` and `max_new_tokens` in local inference ([HF card](https://huggingface.co/MiniMaxAI/MiniMax-Music3)), but the platform API reference documents no seed — hosted generations are non-reproducible; pick-best-of-N is the only variance control.
- **`audio_setting`** (`sample_rate` up to 44100, `bitrate` up to 256000, `format` mp3/wav/pcm): affects fidelity of the render only; no documented effect on pronunciation. Use 44100/256000 so sibilants and retroflex consonants aren't smeared by codec artifacts (fidelity rationale, not a documented pronunciation control).
- Open-weights constraints, if ever self-hosting: prompt "limited to 5,000 tokens", "9,000 acoustic frames" ≈ 5 min max ([HF card](https://huggingface.co/MiniMaxAI/MiniMax-Music3)).

## Confidence and gaps

**Official (MiniMax-owned sources):**
- 14-tag list, 1–3500 lyrics / 0–2000 prompt limits, 10–1000 cover-mode limit, `lyrics_optimizer`, `is_instrumental`, cover params, no seed — [platform API reference](https://platform.minimax.io/docs/api-reference/music-generation). High confidence.
- Structured Caption format + example prompts — [3.0 blog](https://www.minimax.io/blog/minimax-music-3-0-next-generation-open-weights-production-ready-versatile-music-model), [HF](https://huggingface.co/MiniMaxAI/MiniMax-Music3), [GitHub](https://github.com/MiniMax-AI/MiniMax-Music3). High confidence.
- "English and Mandarin strongest; others less consistent", 2–4 lines/section, `\n\n` pauses, parentheticals, BPM/key precision — MiniMax's Replicate org pages for [2.5](https://replicate.com/minimax/music-2.5)/[2.6](https://replicate.com/minimax/music-2.6) (first-party publisher, but written for 2.x; a 3.0-specific Replicate page did not exist at research time). Medium-high confidence that it carries to 3.0.

**Community/secondary (do not cite as official):**
- "40+ languages" — reseller marketing ([eachlabs](https://www.eachlabs.ai/minimax/minimax-music/minimax-music-v2), [invideo](https://invideo.io/ai-models/minimax-ai/)). Unverified.
- 4–8 words per line — [Ambience AI](https://www.ambienceai.com/tutorials/minimax-music-prompting-guide). Plausible folklore.
- Native script ≫ romanized for Indic vocals — [Suno/Udio producer write-up](https://abhishekchaudhary.com/blog/suno-udio-hindi-songwriters-producer-view); different models, directionally consistent with MiniMax's own native-script demos. Medium confidence for MiniMax.

**Gaps (nothing found, would need empirical testing):**
- No official statement on lyric script handling, language auto-detection, or a supported-language list for any music model.
- Zero primary or credible secondary data on MiniMax specifically with Gujarati, Hindi, or Tamil. Recommend an in-house A/B: same song, native script vs romanized lyrics, with and without language-naming in the prompt, across the three languages.
- No documented mechanism behind the "control over… pronunciation" claim in the 3.0 guide.
