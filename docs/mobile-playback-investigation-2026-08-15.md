# Mobile playback investigation — 2026-08-15

## Executive summary

The reported physical-iPhone failure was **not reproducible in the available
iOS 26.2 Simulator**, even when the real app played:

- both saved MiniMax Music 3 MP3s from Downloads;
- the same files through full-response and byte-range HTTP delivery;
- the original, still-valid MiniMax/Aliyun signed URL; and
- a newly generated Music 3.0 result and its fresh signed URL.

Generation, MP3 encoding, file size, byte ranges, and the basic player are
therefore not general causes. Production Vercel logs also show HTTP 200 for
every observed `/api/generate` request in the test window.

One release-blocking client defect is nevertheless confirmed: every automatic
`audio.play()` rejection is discarded, and the app has no media-error or
stall handling. A physical-device-only WebKit rejection therefore becomes the
reported “nothing happened” experience with no diagnostic evidence and no
explicit recovery instruction.

The exact reason the affected physical iPhones reject or abandon playback is
**not proven by this investigation**. A user-activation/autoplay rejection is
the leading device-specific hypothesis, but the simulator also auto-played
after a deliberately delayed 75-second generation response, so that hypothesis
must not be treated as confirmed.

## Scope and environment

- Repository: `dhruvkelawala/mini-mehfil`
- Branch: `main`, fast-forwarded from `b165246` to `3133b07`
- Production: `https://mini-mehfil.vercel.app`
- Simulator: iPhone 17 Pro, iOS 26.2, Safari
- Physical report: iPhones, Safari and Chrome
- Test suite after cleanup: 33/33 passing
- Production code changes made: none

## Evidence

### 1. The production API completed generation

Vercel runtime logs for the observed test window contain only HTTP 200 responses
for `/api/generate`; lyric generation also returned 200. This makes a general
MiniMax or Vercel generation failure unlikely.

The server requests Music 3.0 as a non-streaming MP3 URL at
[`server.js:169`](../server.js#L169) through
[`server.js:227`](../server.js#L227). This matches MiniMax's documented
`output_format: "url"` contract; MiniMax states that URL outputs expire after
24 hours. See the
[official Music Generation API reference](https://platform.minimax.io/docs/api-reference/music-generation).

An HTTP 200 does not prove the browser consumed the body or played the returned
media, but it rules out the reported symptom being explained solely by an
upstream non-200 response.

### 2. Saved MiniMax MP3s are valid and play on simulated iOS

Two files saved on 2026-08-14 were inspected:

| File | Size | Duration | Encoding |
|---|---:|---:|---|
| `music_prod_tts-...WWyrPZZVpNxsDJBZ.mp3` | 5,988,999 B | 186.91 s | MPEG-1 Layer III, 44.1 kHz, stereo, 256 kbps |
| `music_prod_tts-...QGntBxVfiuRkMKpv.mp3` | 4,902,892 B | 153.00 s | MPEG-1 Layer III, 44.1 kHz, stereo, 256 kbps |

The larger file played through the real `public/app.js` player in iOS Safari
when served as:

1. a normal `200 audio/mpeg` response; and
2. a seekable `206 audio/mpeg` response with `Accept-Ranges: bytes`.

This rules out a general incompatibility with MiniMax's MP3 codec, bitrate,
sample rate, saved-file size, or HTTP range playback.

### 3. The original MiniMax CDN URL also played in the simulator

macOS download-origin metadata retained the original signed URL. A redacted
header probe returned:

```text
HTTP/1.1 206 Partial Content
Content-Type: audio/mpeg
Content-Range: bytes 0-1023/5988999
Accept-Ranges: bytes
Content-Disposition: attachment
x-oss-force-download: true
```

The attachment headers were initially suspicious, but the exact signed URL
played successfully through the real player in iOS 26.2 Simulator. They are
therefore not sufficient on their own to explain the physical-device failure.

### 4. A fresh Music 3.0 result also played

A deliberately tiny lyric/prompt request asked for a 5–7 second jingle. MiniMax
returned:

- status: success;
- duration: 58.906 seconds;
- size: 1,888,903 bytes;
- format: 44.1 kHz, stereo, 256 kbps MP3; and
- a fresh signed URL.

MiniMax appears to impose a much longer practical floor than the requested
duration. The fresh signed URL nevertheless auto-played in the same iOS
Simulator player.

### 5. The client hides the only actionable playback failure

`loadSong()` assigns the source, marks the player available, renders the
playback view, and then discards the result of `play()`:

```js
renderPlaybackLyrics();
audio.play().catch(() => {});
```

See [`public/app.js:320`](../public/app.js#L320) through
[`public/app.js:339`](../public/app.js#L339). Replay repeats the same silent
catch at [`public/app.js:421`](../public/app.js#L421) through
[`public/app.js:430`](../public/app.js#L430). The manual Play handler at
[`public/app.js:432`](../public/app.js#L432) also does not handle a rejected
Promise.

The app listens for `play`, `pause`, `timeupdate`, `loadedmetadata`, and
`ended`, but not `error`, `abort`, `stalled`, `suspend`, `waiting`,
or `canplay`. It records neither `audio.error.code` nor
`networkState`/`readyState`.

Per the HTML media contract, `play()` returns a Promise that can reject when
playback is not allowed or the resource cannot be played. See the
[WHATWG HTML media-element specification](https://html.spec.whatwg.org/multipage/media.html#dom-media-play)
and [Apple's HTMLMediaElement.play documentation](https://developer.apple.com/documentation/webkitjs/htmlmediaelement/1630114-play).

This is the confirmed defect: a device-specific rejection is intentionally
converted into silence.

## Symptom-path analysis

There are two different failure paths in the current client:

1. **Playback Promise rejection.** `loadSong()` has already returned
   successfully; its empty catch hides the reason. This path does **not**
   explicitly close the performance view.
2. **Fetch, JSON, missing-source, or synchronous load error.** The form
   submission catch sets `generationFailed = true`, and the finally block
   calls `closePerformance()`. See [`public/app.js:370`](../public/app.js#L370)
   through [`public/app.js:393`](../public/app.js#L393). This path does return
   the user to the main form.

The reported combination—“does nothing” and “goes back to the main
screen”—may involve either imprecise observation of the first path or a second
client-side exception before playback. Current telemetry cannot distinguish
them. The production 200 responses and successful simulator playback make it
unsafe to claim a more specific root cause.

## Ranked root-cause assessment

1. **Physical-device WebKit rejects or abandons the automatic play request**
   — plausible, not proven. Safari and Chrome showing the same iPhone behavior
   points toward a shared platform/media layer. The empty catch guarantees no
   visible explanation. Counter-evidence: iOS 26.2 Simulator accepted automatic
   playback after both a fresh result and a 75-second delayed response.
2. **A physical-device-only media/network condition on the signed CDN URL**
   — plausible, not proven. Private-network, content-filter, iOS-version, or CDN
   route differences could explain simulator/phone divergence. Counter-evidence:
   the exact signed URL, its ranges, and attachment headers worked in Simulator.
3. **Client response parsing or synchronous source setup error** — possible and
   consistent with returning to the main form, but not observed. Production 200
   alone cannot show whether the phone consumed and parsed the response.
4. **Invalid MP3, oversized file, missing byte ranges, general Vercel timeout,
   or lifecycle suspension** — ruled out or strongly disfavoured by the tests
   and the user's foreground-device observation.

## Recommended remediation

### P0 — make playback failure recoverable and observable

1. Replace empty `play()` catches with one playback function that:
   - distinguishes `NotAllowedError` from media/network failures;
   - leaves the recording loaded;
   - shows “Your song is ready — tap Play” for policy rejection; and
   - shows a retryable error for media failure.
2. Do not switch the performance UI to “playing” until the `play` event fires.
3. Handle `audio.error`, `abort`, `stalled`, and `waiting`; capture only
   safe diagnostics: error code, `networkState`, `readyState`, iOS version,
   source origin, and generation trace ID. Never log the token or signed query.
4. Preserve the generated URL and Save action when autoplay fails.

### P1 — remove direct-CDN playback as a variable

If physical-device logging identifies the signed CDN response as the failure,
relay the generated MP3 through a same-origin, seekable endpoint or the existing
share/R2 range-serving path. Preserve `Content-Type: audio/mpeg`, byte ranges,
and streaming; do not buffer multi-megabyte audio into a normal serverless JSON
response.

### P1 — add a regression seam

Add a client test/harness where:

1. `play()` rejects once with `NotAllowedError`;
2. the recording remains loaded;
3. the UI asks for an explicit tap; and
4. a subsequent user-triggered `play()` succeeds.

Also cover a media `error` event and a missing/invalid source. Existing client
tests are source-text assertions and cannot exercise this runtime behavior.

## Physical-device verification needed

The next diagnostic run should use Safari's remote Web Inspector on an affected
iPhone and capture, for one generation:

- the `/api/generate` response status and parsed source shape;
- the `play()` rejection name/message;
- `audio.error?.code`, `networkState`, and `readyState`;
- media request/response status and range headers; and
- whether the document reloads or `closePerformance()` runs.

That single trace will distinguish policy rejection, CDN/media failure, client
exception, and actual WebContent reload without another round of hypothesis.

## Diagnostic preview follow-up

Branch `diagnose/mobile-playback` adds opt-in instrumentation activated with
`?mediaDebug=1`. It does not deliberately throw a JavaScript exception: doing
so could destroy or obscure the evidence. Instead, a rejected `audio.play()`
Promise or media `error` event opens a full-screen fatal diagnostic panel with
the real error name/message and a snapshot of `readyState`, `networkState`,
`MediaError`, user activation, and the playback trigger.

The branch also records API status/timing, source shape and origin, media
lifecycle events, performance-view closes, document visibility/navigation, and
generation trace ID. A capped event trail persists in `localStorage`, so an
actual reload does not erase the preceding breadcrumbs. The panel can copy or
download a JSON report and retry playback from a fresh tap.

Diagnostics redact tokens, lyrics, prompts, request bodies, signed URL paths,
and all URL query strings. The normal application path remains unchanged when
the query flag is absent.

## Conclusion

The app is not proven to “crash” in generation. Generation succeeds, the
recordings are valid, and every available simulator path plays them. The
confirmed release defect is at the playback boundary: errors are swallowed and
the user is given neither a reason nor a reliable explicit-tap recovery. Fixing
that boundary is justified regardless of which physical-iPhone condition is
ultimately captured, and targeted on-device instrumentation is required before
claiming a narrower root cause.
