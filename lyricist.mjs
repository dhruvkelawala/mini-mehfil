// The lyricist: turns a handful of keywords into lyrics MiniMax can actually sing.
//
// This is the whole reason songs stopped coming out random. MiniMax sings the
// `lyrics` field literally, so "Aloopuri Khavsa" was two words stretched over two
// minutes. Here we expand keywords into a full structured song, and expand a vibe
// like "hip hop, upbeat" into the detailed production prompt the music model wants.
//
// Wire format copied from pi-ai's MiniMax provider, then the 88 MB dependency was
// dropped: MiniMax speaks the Anthropic Messages protocol —
// POST {base}/v1/messages with `x-api-key` and `anthropic-version: 2023-06-01`,
// body {model, max_tokens, system, messages}, reply {content: [{type, text}, ...]}.
// Everything provider-specific lives in this file and nothing else.

const API_BASE = process.env.MINIMAX_ANTHROPIC_BASE || 'https://api.minimax.io/anthropic';
const MAX_TOKENS = 6000; // M3 reasons before it writes; leave room for thinking plus the JSON reply.

export const LYRICIST_MODELS = ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'];
export const DEFAULT_MODEL = LYRICIST_MODELS[0];

// The 10-1000 limit in MiniMax's guide is for cover mode only; direct music-3.0
// generation officially accepts 1-3500 lyric chars and 0-2000 prompt chars
// (see docs/research/minimax-native-vocals.md).
export const LYRICS_TARGET_CHARS = 1100;
export const LYRICS_MAX_CHARS = 3500;

const SYSTEM_PROMPT = `You are a songwriter for a mehfil — an intimate live song gathering. You turn a few keywords into a complete, singable song.

You will be given:
- IDEA: a few words about the song's subject, usually typed in Latin letters no matter what language they belong to (e.g. "Aloopuri Khavsa" is Gujarati food written in Latin script).
- VIBE: a few words about the sound (e.g. "hip hop, upbeat").
- LANGUAGE: either "auto" or an explicit language name.

Your job:

1. LANGUAGE. If LANGUAGE is "auto", infer the language from the IDEA. Words written in Latin letters are frequently a romanized non-English language — "Aloopuri Khavsa" is Gujarati, not English. Judge by the words themselves, not by the alphabet they are typed in. If the idea is genuinely English, use English. If LANGUAGE names a language explicitly, use that language and ignore your inference.

2. WRITE THE SONG in that language. Real lyrics with imagery and a point of view — never a description of a song, never placeholder text, never the keywords repeated. Requirements:
   - Use section tags on their own lines, exactly from this set the music model supports: [Intro] [Verse] [Pre Chorus] [Chorus] [Post Chorus] [Bridge] [Hook] [Interlude] [Build Up] [Break] [Inst] [Solo] [Transition] [Outro]. At minimum a [Verse] and a [Chorus]. Write "[Pre Chorus]" with a space, never "[Pre-Chorus]".
   - Keep each section to 2-4 short lines — that is the phrasing the singer handles best. Use a blank line between sections; a blank line also reads as a musical pause.
   - The [Chorus] must repeat verbatim each time it appears — it is the hook people remember.
   - Lines must be singable: short, rhythmic, consistent meter, natural stresses. Rhyme where the language invites it. Ad-libs may go in (parentheses).
   - Match the VIBE. Hip hop wants internal rhyme and a percussive cadence; a ballad wants long vowels and space.
   - Aim for about ${LYRICS_TARGET_CHARS} characters total. Never exceed ${LYRICS_MAX_CHARS}.
   - Keep it clean unless the vibe clearly asks otherwise.

3. TWO SCRIPTS. Produce the lyrics twice:
   - "lyricsNative": the language's own script (ગુજરાતી for Gujarati, देवनागरी for Hindi, 日本語 for Japanese, العربية for Arabic...). This is what gets sung, because the music model pronounces native script most accurately.
   - "lyricsRoman": the same lyrics transliterated into Latin letters, so a listener who cannot read the native script can still read and edit along. Use intuitive phonetic spelling, the way people actually text — "tu hoy to rasta pan ghar lage", not academic diacritics.
   If the language already uses the Latin alphabet (English, Spanish, French...), put identical text in both fields.
   Keep the section tags in English in BOTH versions, and keep both versions line-for-line aligned.

4. PRODUCTION PROMPT. Expand VIBE into the structured caption the music model responds to best, as one paragraph in three ordered parts, under 2000 characters:
   - Global: genre, mood/emotion, energy, an exact BPM number, and a key (e.g. "92 BPM, A minor") — the model follows exact BPM and key very reliably.
   - Vocals: gender, timbre, delivery style (e.g. "warm male baritone, relaxed conversational delivery, doubled hooks"). Name the language and ask for natural native pronunciation.
   - Arrangement: lead and supporting instruments and what they do per section (e.g. "dholak groove under the verses, brass stabs answering the chorus").
   Be specific and concrete, not poetic.

5. TITLE. A short title in the song's language, romanized.

Reply with ONLY a JSON object, no markdown fence and no commentary:
{"title":"","language":"","languageCode":"","nativeScriptName":"","isLatinScript":false,"lyricsNative":"","lyricsRoman":"","prompt":""}`;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} key @returns {unknown} */
function property(value, key) {
  return isRecord(value) ? value[key] : undefined;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isTextBlock(value) {
  return isRecord(value) && value.type === 'text';
}

/** @param {unknown} response @returns {string} */
function extractText(response) {
  const content = property(response, 'content');
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isTextBlock)
    .map(block => block.text)
    .join('');
}

// Models like to wrap JSON in prose or a code fence no matter how firmly you ask.
/** @param {unknown} text @returns {unknown | null} */
function parseJsonLoosely(text) {
  const trimmed = String(text || '').trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(withoutFence.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/** @param {unknown} value @returns {string} */
function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {import('./types/contracts.d.ts').LyricistOptions} [options]
 * @returns {Promise<import('./types/contracts.d.ts').LyricSheet>}
 */
export async function writeLyrics({
  token,
  idea,
  vibe = '',
  language = 'auto',
  model = DEFAULT_MODEL,
  signal
} = {}) {
  if (!token) throw Object.assign(new Error('Add your MiniMax API token.'), { status: 400 });
  if (!idea) throw Object.assign(new Error('Tell me what the song is about.'), { status: 400 });

  const request = [
    `IDEA: ${idea}`,
    `VIBE: ${vibe || 'let the idea suggest the sound'}`,
    `LANGUAGE: ${language || 'auto'}`
  ].join('\n');

  const upstream = await fetch(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: request }]
    }),
    signal
  });

  const raw = await upstream.text();
  let response;
  try { response = JSON.parse(raw); } catch { response = null; }

  if (!upstream.ok) {
    const message = property(property(response, 'error'), 'message')
      || property(property(response, 'base_resp'), 'status_msg')
      || `The lyricist request failed (${upstream.status}).`;
    throw Object.assign(new Error(String(message)), { status: upstream.status === 401 ? 401 : 502 });
  }

  const parsed = parseJsonLoosely(extractText(response));
  if (!parsed) {
    throw Object.assign(new Error('The lyricist replied in a format I could not read. Try again.'), { status: 502 });
  }

  const lyricsNative = asString(property(parsed, 'lyricsNative'));
  const lyricsRoman = asString(property(parsed, 'lyricsRoman')) || lyricsNative;
  if (!lyricsNative) {
    throw Object.assign(new Error('The lyricist came back empty-handed. Try different keywords.'), { status: 502 });
  }

  const isLatinScript = property(parsed, 'isLatinScript') === true || lyricsNative === lyricsRoman;

  return {
    title: asString(property(parsed, 'title')) || idea,
    language: asString(property(parsed, 'language')) || 'Unknown',
    languageCode: asString(property(parsed, 'languageCode')),
    nativeScriptName: asString(property(parsed, 'nativeScriptName')) || 'Latin',
    isLatinScript,
    lyricsNative,
    lyricsRoman,
    prompt: asString(property(parsed, 'prompt')),
    usage: property(response, 'usage') ?? null
  };
}
