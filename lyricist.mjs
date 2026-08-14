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

// MiniMax's own docs disagree with themselves here: the music guide says lyrics are
// 10-1000 characters, the API reference says 3000. We target the smaller number so a
// song is never rejected for length, and cap generously above it.
export const LYRICS_TARGET_CHARS = 900;
export const LYRICS_MAX_CHARS = 3000;

const SYSTEM_PROMPT = `You are a songwriter for a mehfil — an intimate live song gathering. You turn a few keywords into a complete, singable song.

You will be given:
- IDEA: a few words about the song's subject, usually typed in Latin letters no matter what language they belong to (e.g. "Aloopuri Khavsa" is Gujarati food written in Latin script).
- VIBE: a few words about the sound (e.g. "hip hop, upbeat").
- LANGUAGE: either "auto" or an explicit language name.

Your job:

1. LANGUAGE. If LANGUAGE is "auto", infer the language from the IDEA. Words written in Latin letters are frequently a romanized non-English language — "Aloopuri Khavsa" is Gujarati, not English. Judge by the words themselves, not by the alphabet they are typed in. If the idea is genuinely English, use English. If LANGUAGE names a language explicitly, use that language and ignore your inference.

2. WRITE THE SONG in that language. Real lyrics with imagery and a point of view — never a description of a song, never placeholder text, never the keywords repeated. Requirements:
   - Use section tags on their own lines: [Intro] [Verse] [Pre-Chorus] [Chorus] [Bridge] [Hook] [Outro]. At minimum a [Verse] and a [Chorus].
   - The [Chorus] must repeat verbatim each time it appears — it is the hook people remember.
   - Lines must be singable: short, rhythmic, consistent meter, natural stresses. Rhyme where the language invites it.
   - Match the VIBE. Hip hop wants internal rhyme and a percussive cadence; a ballad wants long vowels and space.
   - Aim for about ${LYRICS_TARGET_CHARS} characters total. Never exceed ${LYRICS_MAX_CHARS}.
   - Keep it clean unless the vibe clearly asks otherwise.

3. TWO SCRIPTS. Produce the lyrics twice:
   - "lyricsNative": the language's own script (ગુજરાતી for Gujarati, देवनागरी for Hindi, 日本語 for Japanese, العربية for Arabic...). This is what gets sung, because the music model pronounces native script most accurately.
   - "lyricsRoman": the same lyrics transliterated into Latin letters, so a listener who cannot read the native script can still read and edit along. Use intuitive phonetic spelling, the way people actually text — "tu hoy to rasta pan ghar lage", not academic diacritics.
   If the language already uses the Latin alphabet (English, Spanish, French...), put identical text in both fields.
   Keep the section tags in English in BOTH versions, and keep both versions line-for-line aligned.

4. PRODUCTION PROMPT. Expand VIBE into one dense paragraph describing genre, mood, energy, tempo feel, lead and supporting instruments, vocal character and gender, arrangement, and production texture. Name the language and ask for natural native pronunciation. This directs the music model — be specific and concrete, not poetic.

5. TITLE. A short title in the song's language, romanized.

Reply with ONLY a JSON object, no markdown fence and no commentary:
{"title":"","language":"","languageCode":"","nativeScriptName":"","isLatinScript":false,"lyricsNative":"","lyricsRoman":"","prompt":""}`;

function extractText(response) {
  if (typeof response?.content === 'string') return response.content;
  if (!Array.isArray(response?.content)) return '';
  return response.content
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('');
}

// Models like to wrap JSON in prose or a code fence no matter how firmly you ask.
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

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

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
    const message = response?.error?.message || response?.base_resp?.status_msg || `The lyricist request failed (${upstream.status}).`;
    throw Object.assign(new Error(String(message)), { status: upstream.status === 401 ? 401 : 502 });
  }

  const parsed = parseJsonLoosely(extractText(response));
  if (!parsed) {
    throw Object.assign(new Error('The lyricist replied in a format I could not read. Try again.'), { status: 502 });
  }

  const lyricsNative = asString(parsed.lyricsNative);
  const lyricsRoman = asString(parsed.lyricsRoman) || lyricsNative;
  if (!lyricsNative) {
    throw Object.assign(new Error('The lyricist came back empty-handed. Try different keywords.'), { status: 502 });
  }

  const isLatinScript = parsed.isLatinScript === true || lyricsNative === lyricsRoman;

  return {
    title: asString(parsed.title) || idea,
    language: asString(parsed.language) || 'Unknown',
    languageCode: asString(parsed.languageCode),
    nativeScriptName: asString(parsed.nativeScriptName) || 'Latin',
    isLatinScript,
    lyricsNative,
    lyricsRoman,
    prompt: asString(parsed.prompt),
    usage: response?.usage ?? null
  };
}
