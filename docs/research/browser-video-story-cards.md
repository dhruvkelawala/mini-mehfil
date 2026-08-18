# Turning the story card into a shareable video

Researched 2026-08-18 against primary sources: the WHATWG HTML spec, W3C CSP Level 3,
Web Audio API, Media Capture and Streams, Media Capture from DOM Elements, MediaStream
Recording and WebCodecs specs; WebKit's own source tree on GitHub and the WebKit blog
release notes; Chromium's source on chromium.googlesource.com plus chromestatus.com and
developer.chrome.com; MDN and MDN's `browser-compat-data`; Meta's developer documentation
on developers.facebook.com; Apple's developer documentation; and the npm registry plus the
published bundles of the candidate muxer libraries. Community sources are labelled
**secondary** wherever they appear. Where nothing authoritative exists this document says
"no primary source found" rather than guessing.

Scope: the goal is a ~15–20 s 1080x1920 video with the song playing and the lyrics
animating, handed to the OS share sheet through `navigator.share({ files })` so a person
can drop it into an Instagram Story. Today `src/client/shared/story-card-canvas.ts` paints
a still 1080x1920 JPEG, and the same compiled module runs on both the host app and the
Worker's shared playback page.

---

## What Mini Mehfil should do (actionable summary)

1. **Record in MP4, not WebM.** Every target browser that matters can produce
   `video/mp4` today: WebKit has only ever recorded MP4/H.264 ([WebKit blog,
   2020](https://webkit.org/blog/11353/mediarecorder-api/)), and Chrome gained MP4
   muxing in MediaRecorder in **Chrome 126 on desktop, Android and WebView**
   ([chromestatus 5163469011943424](https://chromestatus.com/feature/5163469011943424),
   [Chrome 126 release notes](https://developer.chrome.com/release-notes/126)). MP4 is
   also the only container Meta's Content Publishing API documents. Probe with
   `MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2')` and fall back
   to bare `'video/mp4'`, then to the still JPEG.
2. **Do not chase WebM.** It buys nothing: WebKit only started recording WebM in Safari
   18.4 ([WebKit blog](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)), and
   MP4 works everywhere WebM does. (The widely repeated "Instagram rejects WebM" claim has
   **no primary source** — see §2.3 — but MP4 sidesteps the question entirely.)
3. **Get the audio track from `createMediaElementSource` + `MediaStreamAudioDestinationNode`,
   not `HTMLMediaElement.captureStream()`.** Safari does not implement
   `HTMLMediaElement.captureStream` at all
   ([MDN BCD](https://github.com/mdn/browser-compat-data/blob/main/api/HTMLMediaElement.json)),
   so the Web Audio route is the only cross-browser one. Remember to also
   `connect(context.destination)` or the song goes silent for the person watching —
   the Web Audio spec requires the media element's audio to stop being "heard directly"
   once the node exists ([spec §1.22](https://www.w3.org/TR/webaudio/)).
4. **The shared page's CSP is self-imposed, and it is the only thing blocking the fast
   path.** Per [CSP3 §6.8.1](https://www.w3.org/TR/CSP3/#effective-directive-for-a-request),
   `fetch()` and XHR are governed by `connect-src` while `<audio src>` is governed by
   `media-src`. `src/worker/sharing.ts:826` sends `default-src 'none'` with no
   `connect-src`, so `fetch` is blocked on the very page the Story button lives on. Adding
   `connect-src 'self'` there is a one-line change to our own policy and unlocks every
   WebCodecs option. If we refuse to widen it, §4.4 lists the two fetch-free routes that
   actually work.
5. **Real-time `MediaRecorder` is the only option that ships today with zero new runtime
   dependencies**, and it costs the person 15–20 s of staring at the screen. It also
   breaks if they switch apps mid-record: the HTML spec removes hidden documents from the
   rendering steps ([HTML §"update the rendering"](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering)),
   canvas capture only produces a frame "when the canvas is painted"
   ([Media Capture from DOM Elements](https://w3c.github.io/mediacapture-fromelement/)),
   and WebKit interrupts the `AudioContext` with
   `InterruptionType::EnteringBackground` ([`AudioContext.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp)).
   Hold the person's attention with a progress affordance and treat backgrounding as a
   cancel.
6. **Aim the encode at Meta's own numbers.** Meta's Sharing to Stories doc asks for
   "1080p and up to 20 seconds in duration" and "Under 50 MB"
   ([developers.facebook.com](https://developers.facebook.com/docs/instagram-platform/sharing-to-stories/)),
   which is exactly the product goal. Chrome's Web Share implementation hard-caps a share
   at 50 MB total ([`navigator_share.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webshare/navigator_share.cc)),
   so keep the clip comfortably under that — 20 s at 6 Mbps is ~15 MB.
7. **Name the file `.mp4`.** On iOS the share sheet's UTI comes from the _filename
   extension_, not the Blob's MIME type ([`WKShareSheet.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Cocoa/WKShareSheet.mm)),
   and an unrecognised extension degrades to `public.data`, which media-only share
   extensions will not activate on. `storyFileName()` in `src/shared/story-card.ts`
   currently hardcodes `.jpg`; it needs an extension parameter.
8. **If a new dependency is ever accepted, it is `mp4-muxer` (MIT, 73.9 KB raw /
   14.9 KB gzip, zero runtime dependencies, ships an IIFE with no imports and no Workers),
   not `mediabunny`** (MPL-2.0, ~168 KB gzip minified, and it constructs Workers from
   `blob:` URLs that `default-src 'none'` blocks). `mp4-muxer` is marked deprecated on npm
   in favour of mediabunny, which is a real risk to weigh — see §4.3. Note `mp4-muxer` is
   _only_ needed for the WebCodecs path; the MediaRecorder path needs nothing.

---

## 1. `MediaRecorder`: what each browser will actually encode

### 1.1 Nothing here is specified

The [W3C MediaStream Recording spec](https://www.w3.org/TR/mediastream-recording/) defines
`isTypeSupported()` but mandates **no container and no codec**. Every claim below is
implementation behaviour read out of vendor source or vendor release notes, not spec
conformance. The spec only constrains the _string_: "If `codecStrings` contains more than
one audio codec or more than one video codec, then return false."

### 1.2 Safari / WebKit — read straight out of the source

WebKit's container dispatch, [`MediaRecorderPrivateWriter.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/mediarecorder/MediaRecorderPrivateWriter.cpp),
accepts exactly four container strings and nothing else:

```cpp
if (equalLettersIgnoringASCIICase(type, "video/mp4"_s) || equalLettersIgnoringASCIICase(type, "audio/mp4"_s))
    return MediaRecorderContainerType::Mp4;
#if ENABLE(MEDIA_RECORDER_WEBM)
if (equalLettersIgnoringASCIICase(type, "video/webm"_s) || equalLettersIgnoringASCIICase(type, "audio/webm"_s))
    return MediaRecorderContainerType::WebM;
#endif
```

The codec allowlist lives in [`MediaRecorderPrivateAVFImpl.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/mediarecorder/MediaRecorderPrivateAVFImpl.cpp),
`isTypeSupported()`:

- **Empty container type returns `true` unconditionally** (so `isTypeSupported('')` is a
  useless probe).
- For `video/mp4` / `audio/mp4`: codecs starting with `avc1`, codecs starting with `mp4a`,
  plus `pcm` and `alac`; `opus` behind `HAVE(AVASSETWRITER_WITH_OPUS_SUPPORTED)`, `av01.`
  behind the AV1 + WebRTC settings, `hev1.`/`hvc1.` behind the H.265 setting.
- For `video/webm` / `audio/webm`: gated on the `mediaRecorderEnabledWebM()` setting, then
  `vp8`/`vp08*`, `vp09*` (profile 0 and 2 behind their own settings), and `opus`. `avc1`
  and `pcm` in WebM are only allowed under the `limitedMatroskaSupport` quirk.
- **`video/x-matroska` is not present anywhere in WebKit.** That string is Chrome-only.

So on both **macOS Safari and iOS Safari** today:

| MIME string                              | Safari                             |
| ---------------------------------------- | ---------------------------------- |
| `video/mp4`                              | true                               |
| `video/mp4;codecs=avc1.42E01E,mp4a.40.2` | true                               |
| `video/webm`                             | true from 18.4                     |
| `video/webm;codecs=vp8,opus`             | true from 18.4                     |
| `video/webm;codecs=vp9,opus`             | true from 18.4 (profile-0 setting) |
| `video/x-matroska`                       | false                              |

**Versions.** WebKit's own announcement, verbatim: _"Safari Technology Preview 105 and
Safari in the latest iOS 14.3 beta enabled support for the MediaRecorder API by default"_
and _"Safari currently supports the MP4 file format with H.264 as video codec and AAC as
audio codec"_ ([webkit.org/blog/11353](https://webkit.org/blog/11353/mediarecorder-api/)).
[MDN's compat data](https://github.com/mdn/browser-compat-data/blob/main/api/MediaRecorder.json)
records `safari: 14.1`, `safari_ios: 14`; WebKit's own post says iOS 14.3, and WebKit is
the better source for its own ship date. WebM output arrived in Safari 18.4 — verbatim:
_"MediaRecorder in WebKit for Safari 18.4 now supports creating WebM files using the Opus
audio codec and either VP8 or VP9 for video"_ — on iOS 18.4, iPadOS 18.4, macOS 15.4 and
visionOS 2.4 ([webkit.org/blog/16574](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)).
That same post shows `mimeType: "video/mp4; codecs=avc1.42000a,opus"` in a sample, and
Safari 26.0 added ALAC and PCM in MP4
([webkit.org/blog/17333](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)).

**So: yes, Safari has supported `video/mp4` (H.264 + AAC) in `MediaRecorder` since the very
first version that had `MediaRecorder` at all — iOS 14.3 / macOS Safari 14.1, late 2020.**
"Safari can't record MP4" is folklore that was never true; "Safari can't produce WebM" was
true until 18.4 and is now stale.

**WebKit's default bitrate is 0 (i.e. "let the platform decide").**
[`MediaRecorderPrivateEncoder.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/mediarecorder/MediaRecorderPrivateEncoder.cpp)
does `m_videoBitsPerSecond = options.videoBitsPerSecond.value_or(0)` and passes
`std::nullopt` downstream when unset. Set `videoBitsPerSecond` explicitly rather than
trusting a default.

### 1.3 Chrome / Chromium — also read straight out of the source

[`media_recorder_handler.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediarecorder/media_recorder_handler.cc):

```cpp
bool CanSupportVideoType(const String& type) {
  return EqualIgnoringAsciiCase(type, "video/webm") ||
         EqualIgnoringAsciiCase(type, "video/x-matroska") ||
         EqualIgnoringAsciiCase(type, "video/matroska") ||
         EqualStringView(type, "video/mp4");
}
```

Note the asymmetry: WebM and Matroska are matched case-insensitively, **`video/mp4` is
matched case-sensitively** — send it lowercase. The codec allowlists in the same file:

- WebM/Matroska video: `vp8`, `vp9`, `av01`, `av1`, plus `h264`/`avc1`/`avc3` under
  `USE_PROPRIETARY_CODECS` and `hvc1`/`hev1` under `ENABLE_HEVC_PARSER_AND_HW_DECODER`;
  audio `opus`, `pcm`.
- MP4: `avc1`, `avc3`, `mp4a.40.2` (all under `USE_PROPRIETARY_CODECS`), `hvc1`/`hev1`
  under the HEVC flag, plus `vp9`, `av01`, `opus`.
- `AudioStringToAudioCodec` maps `mp4a.40.2` → AAC only under `USE_PROPRIETARY_CODECS`.

**Chrome Android.** chromestatus records "MP4 container support for MediaRecorder" —
_"Adds support for muxing audio/video into MP4 containers with MediaRecorder"_ — as
**Enabled by default, shipped in 126 on Desktop, Android and WebView**, iOS not shipped
([chromestatus 5163469011943424](https://chromestatus.com/feature/5163469011943424),
tracked at [crbug 1072056 / issues.chromium.org 40122486](https://bugs.chromium.org/p/chromium/issues/detail?id=1072056),
announced in the [Chrome 126 release notes](https://developer.chrome.com/release-notes/126)).
A later feature added HEVC and the `avc3`/`hev1` variable-resolution strings in Chrome 136
([chromestatus 6375884229181440](https://chromestatus.com/feature/6375884229181440)).
"Chrome can't record MP4" is folklore that was true until mid-2024 and is false now.

Distro Chromium builds compiled without `USE_PROPRIETARY_CODECS` will return **false** for
`mp4a.40.2` and `avc1`. Official Google Chrome builds do not have this problem, but the
probe must still be a real probe, not an assumption.

Chrome's own defaults, from [`media_recorder.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediarecorder/media_recorder.cc):
`kDefaultVideoBitRate = 2500e3` (2.5 Mbps) and `kDefaultAudioBitRate = 128e3`.

### 1.4 The WebM/VP8/VP9 story on Safari, stated carefully

Playback and recording are different timelines and are routinely conflated:

- **Playback**, macOS Safari 14.1, verbatim: _"WebKit on macOS supports WebM files
  containing VP8 or VP9 video tracks and Vorbis audio tracks"_
  ([webkit.org/blog/11648](https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/)).
- **Playback on iOS** only became general in Safari 17.4
  ([webkit.org/blog/15063](https://webkit.org/blog/15063/webkit-features-in-safari-17-4/)).
- **Recording** only from 18.4, as above.
- Safari has historically _claimed_ WebM support it did not deliver — see
  [bug 216652](https://bugs.webkit.org/show_bug.cgi?id=216652) ("Safari reports WebM+VP9
  support on macOS Big Sur Safari, but fails to play"),
  [bug 238546](https://bugs.webkit.org/show_bug.cgi?id=238546),
  [bug 221808](https://bugs.webkit.org/show_bug.cgi?id=221808) ("Unable to play WebM/Opus
  generated from Chrome MediaRecorder"). Another reason not to build on it.

### 1.5 Canvas capture into MediaRecorder on Safari, and known bugs

WebKit explicitly supports it — verbatim: _"this API can take any MediaStreamTrack as
input, be it a capture track, coming from the network using WebRTC, or generated from HTML
(Canvas, WebAudio)"_ ([webkit.org/blog/11353](https://webkit.org/blog/11353/mediarecorder-api/)).

Bugs worth knowing, all primary on bugs.webkit.org:

- [216832](https://bugs.webkit.org/show_bug.cgi?id=216832) "MediaRecorder produces invalid
  video files" — the origin of the "Safari MP4 has a broken duration" story. Real,
  WebKit-acknowledged (_"the moov box was probably giving the duration of the media, which
  is no longer the case now that we are supporting chunk-based outputs"_), and **fixed in
  2020**. Anyone repeating it as current status is repeating folklore.
- [222285](https://bugs.webkit.org/show_bug.cgi?id=222285) `requestData()` returning only a
  header — fixed 2021.
- [229611](https://bugs.webkit.org/show_bug.cgi?id=229611) / [230613](https://bugs.webkit.org/show_bug.cgi?id=230613)
  / [231598](https://bugs.webkit.org/show_bug.cgi?id=231598) / [170325](https://bugs.webkit.org/show_bug.cgi?id=170325)
  — blank / red canvas captureStream recordings. The recurring failure mode is **WebGL**
  canvases, not 2D. Mini Mehfil's card is 2D.
- [279432](https://bugs.webkit.org/show_bug.cgi?id=279432) "MediaRecorder generates huge
  chunks when pausing & resuming camera access" — filed 2024, was still open at research
  time. Only affects pause/resume of a _camera_ track; not our shape.

`isTypeSupported` truth tables per exact string per Safari version: **no primary source
found**. The tables above are derived from WebKit source, which is authoritative for
`main` but not for any particular shipped build. Probe on device.

---

## 2. Will Instagram take the file?

### 2.1 What Meta actually documents

Two separate, unrelated code paths, and they must not be conflated.

**(a) The Content Publishing API** — a server-side, URL-pull API. Meta's specs live on the
[IG User `/media` reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/)
(the [Content Publishing guide](https://developers.facebook.com/docs/instagram-platform/content-publishing/)
itself carries no spec table). Story video, verbatim:

- Container: _"MOV or MP4 (MPEG-4 Part 14), no edit lists, moov atom at the front of the file."_
- Video codec: _"HEVC or H264, progressive scan, closed GOP, 4:2:0 chroma subsampling."_
- Audio codec: _"AAC, 48khz sample rate maximum, 1 or 2 channels (mono or stereo)."_
- Frame rate: _"23-60 FPS."_
- _"Maximum columns (horizontal pixels): 1920"_; aspect _"between 0.1:1 and 10:1 but we
  recommend 9:16"_.
- Duration: _"60 seconds maximum, 3 seconds minimum."_ File size: _"100MB maximum."_
- Bitrate: _"VBR, 25Mbps maximum"_, audio _"128kbps"_.

WebM is **not** in that container list. But this API is irrelevant to Mini Mehfil — we
never upload to Instagram, the person does, through the share sheet.

**(b) Sharing to Stories** — Meta's proprietary hand-off for _native_ apps
([developers.facebook.com](https://developers.facebook.com/docs/instagram-platform/sharing-to-stories/)):
iOS uses the `instagram-stories://share` URL scheme plus `UIPasteboard` keys
(`com.instagram.sharedSticker.backgroundVideo` and friends); Android uses the
`com.instagram.share.ADD_TO_STORY` intent. As `story-card-canvas.ts` already notes in its
header comment, **a web page cannot do this** — it cannot write those pasteboard items and
cannot attach a link sticker. But the media formats that doc lists are the closest thing
Meta publishes to "what the Instagram app can ingest", verbatim:

- iOS background video: _"Data for video asset in a supported format (H.264, H.265, WebM)"_
- Android background asset: _"Uri to an image asset (JPG, PNG) or video asset (H.264, H.265, WebM)"_
- _"Minimum dimensions 720x1280"_, _"Recommended image ratios 9:16 or 9:18"_,
  _"1080p and up to 20 seconds in duration"_, _"Under 50 MB"_.

Those last two lines are worth pinning up: Meta's own recommendation is **1080p, ≤20 s,
under 50 MB**, which is precisely the clip we want to make.

**(c) What the Instagram app accepts from `UIActivityViewController` / `ACTION_SEND`:
no primary source found.** Meta documents nothing about the generic OS share-sheet path,
and publishes no `CFBundleDocumentTypes` / `NSExtensionActivationRule` / accepted-UTI list
for the Instagram iOS app. Establishing this would require inspecting the shipped IPA,
which is not a Meta-published document.

### 2.2 What "documented" vs "inferred" means here

| Claim                                                                                             | Status                                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Content Publishing API Story video is MOV/MP4, H.264/HEVC + AAC, ≤60 s, ≤100 MB, 9:16 recommended | **Documented** by Meta                                                         |
| Sharing-to-Stories lists H.264, H.265 and WebM as supported video for the Instagram app           | **Documented** by Meta                                                         |
| Meta recommends 1080p, ≤20 s, under 50 MB for a Stories background video                          | **Documented** by Meta                                                         |
| Sharing-to-Stories format list also describes what the share-sheet path accepts                   | **Inferred.** Different entry point; plausible but unproven                    |
| Content Publishing API's MOV/MP4-only container list applies to the app                           | **Inferred, and probably wrong** — different code path, and it contradicts (b) |

### 2.3 "Instagram rejects WebM from the share sheet" — no primary source found

Searched developers.facebook.com, help.instagram.com and Apple's developer documentation.
**No Meta page, help article or developer doc states that Instagram rejects, filters or
fails on a `video/webm` file received via `UIActivityViewController` or `ACTION_SEND`.**

Everything asserting it is **secondary** and weak: SEO blog posts, Medium articles, Apple
Developer Forums threads about URL sharing. None demonstrates a WebM-specific rejection.

Worth flagging that the strongest _primary_ evidence points the other way: Meta's own
Sharing to Stories doc lists WebM as a supported background video format on both iOS and
Android. Treat "Instagram rejects WebM" as **unproven**. We should still ship MP4 — not
because WebM is known bad, but because MP4 is documented-good everywhere and costs nothing
extra.

### 2.4 How `navigator.share({ files })` decides which apps appear

**The spec specifies nothing about types.** [W3C Web Share](https://w3c.github.io/web-share/)
enumerates no permitted MIME types and delegates entirely to the user agent. It only says,
verbatim: _"If a file type is being blocked due to security considerations, return a
`NotAllowedError` `DOMException`"_, and gives the UA discretion — _"If the user agent
believes sharing any of the files in `files` would result in a potentially hostile share
(i.e., the user agent determines a file is malicious in some way, because of its contents,
size, or other characteristic), return false."_ `canShare()` can be called without
transient activation, which is what `canShareStoryCard()` already relies on.

**Chrome has a real allowlist, and `video/mp4` and `video/webm` are both on it.** Three
mutually consistent primary sources: [`share_service_impl.cc`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/webshare/share_service_impl.cc)
(`IsDangerousFilename` / `IsDangerousMimeType`), the canonical doc
[`FILE_TYPES.md`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webshare/FILE_TYPES.md),
and the Android implementation
[`ShareServiceImpl.java`](https://chromium.googlesource.com/chromium/src/+/main/components/browser_ui/webshare/android/java/src/org/chromium/components/browser_ui/webshare/ShareServiceImpl.java).
Both the extension **and** the MIME type are checked; failing either yields
`PERMISSION_DENIED`. Permitted video: `.m4v`/`.mp4` → `video/mp4`, `.mpeg`/`.mpg`,
`.ogm`/`.ogv`, `.webm` → `video/webm`. Notably **`.mov` / `video/quicktime` is NOT
permitted** by Chromium — do not name the file `.mov`.

**WebKit has no allowlist at all.** `Navigator::canShare()` in
[`Navigator.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/Navigator.cpp)
performs no file-type check; [`ShareDataReader.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/ShareDataReader.cpp)
and [`WKShareSheet.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Cocoa/WKShareSheet.mm)
contain no MIME allowlist and no size cap. So on iOS, `navigator.share` will hand _any_
type to the system sheet — **the filtering is downstream, in iOS and in the receiving app.**

**On iOS the UTI comes from the filename extension.** `WKShareSheet.mm`:

```objc
static NSString *typeIdentifierForFileURL(NSURL *url)
{
    ...
    if (RetainPtr pathExtension = [url pathExtension]) {
        if (RetainPtr type = [UTType typeWithFilenameExtension:pathExtension.get()])
            return type.get().identifier;
    }
    return UTTypeData.identifier;
}
```

WebKit writes the shared `File` to a temp URL and resolves the UTI from the path
extension; an unknown extension falls back to **`public.data`**. That UTI is what
`UIActivityItemSource`'s
[`activityViewController(_:dataTypeIdentifierForActivityType:)`](<https://developer.apple.com/documentation/uikit/uiactivityitemsource/activityviewcontroller(_:datatypeidentifierforactivitytype:)>)
vends, and the receiving extension's
[`NSExtensionActivationRule`](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/AppExtensionKeys.html)
decides whether it appears — Apple, verbatim: _"Specifies the semantic data types that an
app extension supports. Each key in the dictionary represents a data type, such as image,
video, or web URL."_ Keys include `NSExtensionActivationSupportsMovieWithMaxCount`. An
unrecognised extension resolves to `public.data` or a
[dynamic `dyn.*` identifier](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/understanding_utis/understand_utis_conc/understand_utis_conc.html)
and will fail a movie-typed activation rule.

**Consequence for us: name the file `SongTitle.mp4`.** The `File`'s MIME type is not what
iOS looks at. `storyFileName()` currently always appends `.jpg`.

Whether a `video/webm` file is _offered to Instagram specifically_ on iOS: **no primary
source found.** It depends on what Instagram's extension declares, which Meta does not
publish. Another reason MP4 is the safe answer.

**File-size limits.** Chrome: [`navigator_share.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webshare/navigator_share.cc)
declares `kMaxSharedFileCount = 10` and `kMaxSharedFileBytes = 50U * 1024 * 1024`, throwing
`NotAllowedError` with a "Share too large" console warning above that. (An open request to
raise it: [issues.chromium.org/408128761](https://issues.chromium.org/issues/408128761).)
iOS/WebKit: **no primary source found** — no size or count constant exists in
`Navigator.cpp`, `ShareDataReader.cpp` or `WKShareSheet.mm`, and Apple documents none. The
often-cited "~300 MB" figure traces to a [Medium post by Jeremy Keith](https://adactio.medium.com/the-web-share-api-in-safari-on-ios-a192dd607a0e)
(**secondary**, empirical).

---

## 3. Getting the song into the recording

### 3.1 `createMediaElementSource` → `MediaStreamAudioDestinationNode` works, with a catch

Both nodes are supported everywhere we care about. Per
[MDN's compat data](https://github.com/mdn/browser-compat-data/blob/main/api/MediaStreamAudioDestinationNode.json),
`MediaStreamAudioDestinationNode` is Chrome 25 / Safari 11 / Safari iOS 11.

**The re-routing gotcha is normative, not folklore.** [Web Audio API §1.22](https://www.w3.org/TR/webaudio/),
verbatim: _"The `HTMLMediaElement` MUST behave in an identical fashion after the
`MediaElementAudioSourceNode` has been created, except that the rendered audio will no
longer be heard directly, but instead will be heard as a consequence of the
`MediaElementAudioSourceNode` being connected"_ — and on `createMediaElementSource`, _"As a
consequence of calling this method, audio playback from the `HTMLMediaElement` will be
re-routed into the processing graph of the `AudioContext`."_

So the graph must be:

```
audio element → MediaElementAudioSourceNode ─┬→ context.destination        (person hears it)
                                             └→ MediaStreamAudioDestinationNode (recorder hears it)
```

Omit the first branch and the song goes silent for the person while it records — a
regression on the shared page, which is a _playback_ page. The node is created once per
element for the lifetime of the element; calling `createMediaElementSource` twice on the
same element throws, so cache it.

**This node is also the only cross-browser way to do it.** `HTMLMediaElement.captureStream()`
would be the obvious alternative, but [MDN's compat data](https://github.com/mdn/browser-compat-data/blob/main/api/HTMLMediaElement.json)
records `safari: false` and `safari_ios: false` — WebKit does not implement it. Chrome has
had it since 62.

### 3.2 CORS: same-origin is fine, cross-origin is silence

[Web Audio API §1.22.4 "Security with MediaElementAudioSourceNode and Cross-Origin
Resources"](https://www.w3.org/TR/webaudio/), verbatim: _"a `MediaElementAudioSourceNode`
MUST output silence instead of the normal output of the `HTMLMediaElement` if it has been
created using an `HTMLMediaElement` for which the execution of the fetch algorithm labeled
the resource as CORS-cross-origin."_

Mini Mehfil's audio is served same-origin at `/s/<id>/audio` (the shared page's element is
literally `<audio id="audio" src="/s/<id>/audio">`), so this is not a problem — the node
outputs real audio. It **would** silently produce a silent video if the audio were ever
moved to a different origin without CORS. Note "silently": there is no exception, just
silence. Worth an explicit assertion in any test.

Separately, the _canvas_ must stay origin-clean: [Media Capture from DOM Elements](https://w3c.github.io/mediacapture-fromelement/),
verbatim: _"Content from a canvas that is not origin-clean MUST NOT be captured. This
method throws a `SecurityError` exception if the canvas is not origin-clean."_ The existing
`loadStoryBackground()` already loads a same-origin background for exactly this reason
(for `toBlob`), and the same property is what makes `captureStream()` legal.

### 3.3 iOS requires a gesture to start the AudioContext, and backgrounding interrupts it

**Gesture.** [Web Audio API](https://www.w3.org/TR/webaudio/), verbatim: _"An
`AudioContext` is said to be allowed to start if the user agent allows the context state to
transition from 'suspended' to 'running'. A user agent may disallow this initial
transition, and to allow it only when the `AudioContext`'s relevant global object has
sticky activation."_ WebKit implements exactly that —
[`AudioContext.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp):

```cpp
if (!page || page->requiresUserGestureForAudioPlayback())
    addBehaviorRestriction(BehaviorRestrictionFlags::RequireUserGestureForAudioStartRestriction);
...
if (userGestureRequiredForAudioStart()) {
    if (!document->processingUserGestureForMedia())
        return false;
    removeBehaviorRestriction(BehaviorRestrictionFlags::RequireUserGestureForAudioStartRestriction);
}
```

Practically: build and `resume()` the `AudioContext` inside the same click handler that
starts recording. The shared page's existing `pointerdown`-warms-`click`-shares pattern for
the story card is the right shape to copy — but note the `AudioContext` work must happen in
a handler with an active user gesture, not in a promise continuation after one.

**Backgrounding.** The same file shows WebKit deliberately interrupting the context when the
app goes to the background:

```cpp
m_mediaSession->beginInterruption(PlatformMediaSession::InterruptionType::EnteringBackground);
```

and a distinct `State::Interrupted` alongside `Suspended`. **No primary source found** for
the precise behaviour when the iPhone screen locks specifically (as opposed to the app
being backgrounded) — but the interruption machinery is the same `PlatformMediaSession`
path, and the visual half of the recording is separately dead (§5.1), so the practical
answer for a real-time recorder is the same: it will not survive.

### 3.4 Combining the tracks into one `MediaStream`

Specified and reliable. [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
declares `constructor(sequence<MediaStreamTrack> tracks)` on `MediaStream`, so
`new MediaStream([videoTrack, audioTrack])` is exactly the sanctioned form. Shape:

```js
const videoTrack = canvas.captureStream(30).getVideoTracks()[0];
const audioTrack = mediaStreamDestination.stream.getAudioTracks()[0];
const recorder = new MediaRecorder(new MediaStream([videoTrack, audioTrack]), {
  mimeType,
});
```

One caveat from the [MediaStream Recording spec](https://www.w3.org/TR/mediastream-recording/),
verbatim: _"If any Track within the `MediaStream` is muted or not enabled at any time, the
UA will only record black frames or silence since that is the content produced by the
Track."_ A muted track does not stop the recording — it silently degrades it. That is the
failure mode when the page is backgrounded.

---

## 4. The faster-than-real-time route: WebCodecs

### 4.1 Support: Chrome for years, Safari only fully from 26

|                         | `VideoEncoder` | `AudioEncoder` | `VideoFrame` | `AudioData` |
| ----------------------- | -------------- | -------------- | ------------ | ----------- |
| Chrome / Chrome Android | 94             | 94             | 94           | 94          |
| Safari / Safari iOS     | 16.4           | **26**         | 16.4         | **26**      |
| Firefox                 | 130            | 130            | —            | —           |

Source: [MDN browser-compat-data](https://github.com/mdn/browser-compat-data/tree/main/api)
(`VideoEncoder.json`, `AudioEncoder.json`, `VideoFrame.json`, `AudioData.json`), which is
corroborated by WebKit's own release notes. Safari 16.4, verbatim: _"Safari 16.4 adds
support for the **video portion** of Web Codecs API"_
([webkit.org/blog/13966](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)) —
emphasis on "video portion". The underlying work is itemised in the
[Safari Technology Preview 157 release notes](https://webkit.org/blog/13575/release-notes-for-safari-technology-preview-157/),
verbatim: _"Added support for WebCodecsVideoEncoder"_, _"Added support for AVC H.264
WebCodecsVideoEncoder and WebCodecsVideoDecoder"_. iOS got it in the same release (BCD
records `safari_ios` as a mirror of `safari: 16.4`).

Audio arrived nearly three years later: Safari 26.0, verbatim, _"expands support for
WebCodecs API by adding AudioEncoder and AudioDecoder"_, on iOS 26, iPadOS 26, macOS
Tahoe/Sequoia/Sonoma and visionOS 26
([webkit.org/blog/17333](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/); previewed
at [WWDC25](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/)).
Nothing has changed since — Safari 26.4 carries only a WebCodecs bug fix
([webkit.org/blog/17862](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/)).

**This is the decisive constraint on WebCodecs for Mini Mehfil: iPhones on iOS 16.4
through 18.x can encode video but have no audio encode path at all.** A silent story video
is not the product. MDN states it flatly: _"AAC encoding is universally supported on Safari
versions that support `AudioEncoder` (Safari 26+), but previous versions of Safari do not
support audio encoding in general"_
([MDN, WebCodecs codec selection](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection)).

### 4.2 H.264 and AAC availability

Codec availability is **not specified**. The
[WebCodecs codec registry](https://w3c.github.io/webcodecs/codec_registry.html) defines
codec _string formats_ only (`avc1.*`, `avc3.*`, `mp4a.*`, `opus`, `vp8`, `vp09.*`,
`av01.*`, `hev1.*`, `hvc1.*`, `flac`, `mp3`, `vorbis`, `pcm-*`) and says, verbatim:
_"Implementers of WebCodecs are not required to support any particular codec nor registry
entry."_ The [spec itself](https://w3c.github.io/webcodecs/) says _"User Agents don't have
to support any particular codec type or configuration."_ Availability is a runtime question
answered by `VideoEncoder.isConfigSupported()` / `AudioEncoder.isConfigSupported()` — MDN's
guidance is explicit: _"Before encoding, use `VideoEncoder.isConfigSupported()` to verify
that a given configuration is supported on the current device"_
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection)).
But both engines' source is explicit about what they will accept:

- WebKit, [`WebCodecsVideoEncoder.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webcodecs/WebCodecsVideoEncoder.cpp):
  accepts `vp8`, `vp09.00`, `avc1.`, plus `vp09.02` / `hev1.` / `hvc1.` / `av01.0` behind
  settings. **`avc1.` (H.264) is unconditionally allowed.** Gotcha in the same file:
  `if (config.codec.startsWith("avc1."_s) && (!!(config.width % 2) || !!(config.height % 2)))`
  — H.264 requires even dimensions. 1080x1920 is fine.
- WebKit, [`WebCodecsAudioEncoder.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webcodecs/WebCodecsAudioEncoder.cpp):
  `mp4a.40.2`, `mp4a.40.02`, `mp4a.40.5`, `mp4a.40.29`, `mp4a.40.42`, plus `mp3`, `opus`,
  `alaw`, `ulaw`, `flac`, `vorbis`, `pcm-*`. **AAC-LC (`mp4a.40.2`) is available — from
  Safari 26.**
- Chromium, [`audio_encoder.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webcodecs/audio_encoder.cc):
  exactly two encode paths — Opus via `CreateSoftwareAudioEncoder()` and **AAC via
  `CreatePlatformAudioEncoder()`**. No PCM, FLAC or MP3 encoders. Because AAC comes from
  the OS, MDN records that AAC encoding _"is not supported in Firefox on any platform, or
  in any browser on desktop Linux"_
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection)).
  MDN's own `AudioEncoder.isConfigSupported()` reference probes `"mp4a.40.2"` directly, so
  it is a documented, expected config string.

Two further cautions:

- **H.264 encode is not guaranteed on every Android device.** Chromium's software H.264
  encoder (OpenH264) is behind the `media_use_openh264` build flag, which _"affects WebRTC,
  WebCodecs, and MediaRecorder APIs"_ and is disabled by default on Android
  ([crbug 40519162](https://issues.chromium.org/issues/40519162),
  [chromestatus 6417796455989248](https://chromestatus.com/feature/6417796455989248)). On a
  device whose MediaCodec has no H.264 encoder, `isConfigSupported({codec:'avc1.…'})` can
  return false. (Confidence: medium — assembled from the issue tracker and chromestatus
  rather than a single statement.)
- **H.264 is patented.** MDN, verbatim: _"While browser vendors hold licenses covering the
  H.264 encoder implementations used by WebCodecs, the codec is subject to royalties in
  certain circumstances. Developers should review usage with legal counsel."_ This applies
  equally to the MediaRecorder path in Option A; noting it once here.

**Hardware acceleration is a hint, not a lever.** [WebCodecs spec §7.9](https://w3c.github.io/webcodecs/#hardware-acceleration),
verbatim: _"`prefer-hardware` and `prefer-software` are hints. While User Agents SHOULD
respect these values when possible, User Agents may ignore these values in some or all
circumstances for any reason."_ The spec additionally requires UAs to avoid leaking
fingerprinting signal through acceptance or rejection of the preference. So you cannot
force hardware encode, and you cannot detect whether you got it.

Always call `isConfigSupported()` — the source lists gate on build flags and device
capabilities that a static table cannot capture.

### 4.3 MP4 muxing needs a library

Numbers below are from the npm registry and the published CDN bundles, measured
2026-08-18.

**[`mp4-muxer`](https://github.com/Vanilagy/mp4-muxer) 5.2.2**

- License **MIT**.
- Runtime dependencies: **zero** in substance. `package.json` lists
  `@types/dom-webcodecs` and `@types/wicg-file-system-access`, both types-only packages
  that ship no runtime code (arguably mis-declared as `dependencies`).
- Published bundles: `build/mp4-muxer.js` (IIFE/CJS) **73,921 bytes raw, 14,895 bytes
  gzip**; `build/mp4-muxer.mjs` (ESM) 69,011 / 14,387. Whole tarball unpacks to 155,878
  bytes including types and sourcemaps.
- **It survives inlining.** The IIFE build begins `"use strict";var Mp4Muxer = (() => {`
  and contains **zero** `import` or `require(` statements. That is structurally identical
  to what `scripts/build-story-card.ts` already produces
  (`const storyCard=(()=>{const exports={}; … return exports})();`), so it can be
  concatenated into the same `<script nonce>` with no loader, no `connect-src` and no
  `worker-src`. This is the only candidate that satisfies the shared page's CSP unchanged.
- No `new Worker()`, no `importScripts`, no dynamic `import()`, no WebAssembly.
- **Risk: the npm package is marked deprecated** — _"This library is superseded by
  Mediabunny. Please migrate to it."_ It still works and is still published, but it will
  not get fixes. Under `AGENTS.md`'s "small and audited" rule this is a vendoring decision
  as much as a dependency decision.

**[`mediabunny`](https://github.com/Vanilagy/mediabunny) 1.55.1 — the maintained successor,
and riskier here on three axes**

- License **MPL-2.0** (weak file-level copyleft — not MIT; worth a deliberate call given
  `solid-js` is the only runtime library today). The repo describes it as _"a very
  permissive weak copyleft license, not much different from the MIT License"_, which is
  fair but is not the same thing as MIT.
- Runtime dependencies: zero in substance (again two `@types` packages). Bundles no
  encoders of its own except PCM — it relies on WebCodecs, and its docs say so: _"The
  availability of the codecs provided by the WebCodecs API depends on the browser and thus
  cannot be guaranteed by this library"_ ([mediabunny.dev](https://mediabunny.dev/guide/supported-formats-and-codecs)).
- `"type": "module"`, ESM-first. `dist/bundles/mediabunny.min.cjs` is **658,526 bytes raw /
  ~168 KB gzip** (the unminified `.cjs` is 1,502,439 / ~269 KB). It _is_ IIFE-shaped and
  exposes a `Mediabunny` global, so it would inline — but 168 KB gzip against a 35 KiB host
  budget (`scripts/check-bundle-size.ts`) is not viable. The advertised _"as small as 5 kB
  gzipped"_ is a tree-shaken floor that requires a real bundler, which the shared page does
  not have: getting there would mean replacing `ts.transpileModule` in
  `scripts/build-story-card.ts` with esbuild.
- **It constructs Workers from `blob:` URLs, which our CSP blocks.** The minified bundle
  contains four `new Worker` sites paired with `URL.createObjectURL`, generated by a
  vendored [inline-worker esbuild plugin](https://github.com/Vanilagy/mediabunny/blob/main/scripts/esbuild/inlined-workers.ts)
  whose emitted helper is verbatim `const blob = new Blob([scriptText], { type:
"text/javascript" }); const url = URL.createObjectURL(blob); const worker = new
Worker(url, …)`. Under `default-src 'none'` with no `worker-src`/`child-src`, those
  throw (§4.4). Three of the four sites look opt-in (alpha-channel split/merge,
  `MediaStreamTrackProcessor` input); the fourth is an unthrottled-timer helper in
  `src/misc.ts` whose callers **could not be traced**. **Unverified whether the plain
  `Output` / `Mp4OutputFormat` mux path touches any of them** — that is the single thing to
  test on device before choosing mediabunny.

**Alternatives, checked and rejected.**

| Library                                                                                     | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`webm-muxer`](https://github.com/Vanilagy/webm-muxer) (MIT, 147,682 B unpacked, CSP-clean) | Wrong container, and also npm-deprecated in favour of mediabunny                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [`mp4box.js`](https://github.com/gpac/mp4box.js) (BSD-3, 2.26 MB unpacked)                  | It is a **demuxer/parser**, not a muxer — it cannot write MP4 from encoded chunks. Also ships code-split ESM/CJS chunks (`import … from "./rolldown-runtime-….mjs"`), so it is not single-file inlinable, and its advertised `dist/mp4box.all.js` 404s on 2.4.1                                                                                                                                                                                                                                                                                                                                                                                                              |
| [`mux.js`](https://github.com/videojs/mux.js) (Apache-2.0, 4.7 MB unpacked)                 | Transmuxes MPEG-TS → fMP4 for HLS; not a WebCodecs-chunk muxer. Also the only candidate with **real** runtime deps (`global`, `@babel/runtime`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [`jsmpeg`](https://github.com/phoboslab/jsmpeg)                                             | An MPEG-1 _player_, not a muxer. Loads over Ajax/WebSocket. Wrong tool entirely                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [`ffmpeg.wasm`](https://github.com/ffmpegwasm/ffmpeg.wasm)                                  | **Disqualified three times over.** `@ffmpeg/util`'s `toBlobURL` is literally `await (await fetch(url)).arrayBuffer()` and the documented `load()` call fetches both `ffmpeg-core.js` and `ffmpeg-core.wasm` — blocked by the missing `connect-src`. `load()` also does `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` — blocked by `worker-src`. And `@ffmpeg/core@0.12.10` ships a **32,232,419-byte** `.wasm`, which is disqualifying on a phone regardless. ([usage docs](https://ffmpegwasm.netlify.app/docs/getting-started/usage), [`@ffmpeg/util` source](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/packages/util/src/index.ts)) |

**One relevant escape hatch, also blocked.** [`@mediabunny/aac-encoder`](https://github.com/Vanilagy/mediabunny/blob/main/packages/aac-encoder/README.md)
exists precisely for browsers whose WebCodecs lacks AAC — _"uses a fast, size-optimized
WASM build of FFmpeg's AAC encoder under the hood"_ — which would in principle rescue iOS
16.4–18.x. Its wasm is embedded in the JS rather than fetched as a sidecar (good), but the
bundle is **992,389 B raw / ~254 KB gzip** and it also uses the inlined-blob-Worker
pattern, so it hits the same `worker-src` wall. Not a route on the shared page as the CSP
stands.

### 4.4 The CSP problem: `fetch` is blocked on the shared page, and that is decisive

This is the sharpest constraint in the whole investigation, so it is worth being exact.

**Which directive governs what.** [CSP3 §6.8.1 "Get the effective directive for request"](https://www.w3.org/TR/CSP3/#effective-directive-for-a-request)
switches on the request's _destination_:

> `"audio"`, `"track"`, `"video"` → Return `media-src`.
> the empty string → Return `connect-src`.
> `"serviceworker"`, `"sharedworker"`, `"worker"` → Return `worker-src`.
> … Return `connect-src`. **Note:** The algorithm returns `connect-src` as a default fallback.

and [§6.1.2](https://www.w3.org/TR/CSP3/#directive-connect-src) says `connect-src`
_"controls requests which transmit or receive data from other origins. This includes APIs
like `fetch()`, [XHR], [EVENTSOURCE], [BEACON], and a's ping"_, while
[§6.1.8](https://www.w3.org/TR/CSP3/#directive-media-src) says `media-src` _"restricts the
URLs from which video, audio, and associated text track resources may be loaded"_ and gives
`<audio src>` as its example.

So on `src/worker/sharing.ts:826` — `default-src 'none'; img-src 'self' data:; media-src
'self'; style-src 'nonce-X'; script-src 'nonce-X'` — with
[§6.8.3's fallback list](https://www.w3.org/TR/CSP3/#directive-fallback-list)
(`connect-src` → `default-src`):

- `<audio src="/s/<id>/audio">` — **allowed** by `media-src 'self'`. Already works.
- `fetch('/s/<id>/audio')` and `XMLHttpRequest` — **blocked**. `connect-src` is absent, so
  it falls back to `default-src 'none'`.
- `new Worker(...)` — **blocked**. `worker-src` falls back to `child-src` → `script-src` →
  and lands on `script-src 'nonce-X'`. Nonces are matched only in the _inline_ and
  _element_ checks; [§6.7.2.5 "Does request match source list?"](https://www.w3.org/TR/CSP3/#match-request-to-source-list)
  matches a request's URL against the list, and a `'nonce-…'` expression is not a URL. So
  no worker URL can match. (Derived from the spec algorithms rather than a vendor
  statement — flagged as reasoning, not a quoted rule.)
- Service workers — same `worker-src` path, also blocked.

**`decodeAudioData` needs an `ArrayBuffer` and nothing else supplies one.** [Web Audio
API](https://www.w3.org/TR/webaudio/), verbatim: _"Asynchronously decodes the audio file
data contained in the `ArrayBuffer`. The `ArrayBuffer` can, for example, be loaded from an
`XMLHttpRequest`'s response attribute after setting the `responseType` to
'arraybuffer'."_ There is no `decodeAudioData(url)`, no `decodeAudioData(mediaElement)`,
and `AudioDecoder` (WebCodecs) equally needs an `EncodedAudioChunk` built from bytes.

**Every route to audio bytes on that page, enumerated:**

| Route                                                                                        | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch()` / `XHR` / `EventSource` / `WebSocket`                                              | Blocked — `connect-src` (CSP3 §6.1.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Worker or Service Worker doing the fetch                                                     | Blocked — `worker-src` → `script-src 'nonce-X'`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Cache Storage (`caches.match`)                                                               | No help — populating it needs a fetch or a SW                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `<audio src>` + `createMediaElementSource`                                                   | **Works, but real-time only.** `media-src 'self'` permits the load; the bytes are never exposed to script, only samples as they play                                                                                                                                                                                                                                                                                                                                                           |
| `<audio src="data:…">`                                                                       | Would need `media-src data:`; and still exposes no bytes to script                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Inline the bytes in the HTML** (base64 in the existing `<script type="application/json">`) | **Works, no CSP change.** No request is made at all, so no directive applies                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **A nonced `<script src>` that assigns the base64 string**                                   | **Works, no CSP change.** [CSP3 §6.7.1.1](https://www.w3.org/TR/CSP3/#script-pre-request) — _"If the result of executing §6.7.2.3 Does nonce match source list? on request's cryptographic nonce metadata and this directive's value is 'Matches', return 'Allowed'"_. The nonce is already templated into the page; a script element can also read its own via `document.currentScript.nonce` ([HTML §2.5.6](https://html.spec.whatwg.org/multipage/urls-and-fetching.html#nonce-attributes)) |
| **Add `connect-src 'self'` to the policy**                                                   | **Works, and it is our own policy.** One line in `src/worker/sharing.ts`                                                                                                                                                                                                                                                                                                                                                                                                                       |

The two "inline the bytes" routes cost a base64 inflation of 4/3. A whole 3-minute MP3 at
192 kbps is ~4.3 MB → ~5.8 MB of base64 in the HTML, which is absurd for a page that must
render fast. A pre-trimmed 20 s excerpt at 128 kbps is ~320 KB → ~430 KB of base64, which
is merely bad. **The honest conclusion is that if we want WebCodecs on the shared page, we
should add `connect-src 'self'` rather than contort around it.** That directive permits
same-origin fetches only, which is a far smaller widening than it sounds.

### 4.5 Is WebCodecs actually faster than real time on a phone?

**No primary source found.** Neither the [WebCodecs spec](https://w3c.github.io/webcodecs/),
Chrome's documentation, nor WebKit's release notes publishes a benchmark for encoding a
1080x1920 clip on a phone, and no vendor makes a throughput claim.
[Chrome's own WebCodecs best-practices page](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs)
contains no numbers, no `hardwareAcceleration` discussion and no Android section — only the
qualitative _"modern browsers already ship with a variety of codecs (which are often
accelerated by hardware)"_. MDN is likewise qualitative. The spec's only lever is the
`hardwareAcceleration` hint, which §4.2 shows is explicitly non-binding.

What can be said without inventing numbers: modern iPhones and Android flagships ship
hardware H.264 encoders that the platform uses for camera capture at 4K60, so 1080x1920 at
30 fps is well inside their envelope — but the browser's per-frame overhead (drawing the
canvas, constructing a `VideoFrame`, muxing) is the unknown, and it is the part nobody has
measured publicly. **If we build this, we must measure it ourselves on real devices before
promising anyone a faster-than-real-time export.**

---

## 5. Practical constraints

### 5.1 Recording does not survive a hidden page

Three independent primary facts stack up:

1. **The document stops rendering.** [HTML, "update the rendering"](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering),
   verbatim: _"**Filter non-renderable documents**: Remove from `docs` any `Document`
   object `doc` for which any of the following are true: `doc` is render-blocked; **`doc`'s
   visibility state is 'hidden'**; …"_. `requestAnimationFrame` callbacks run inside those
   rendering steps, so they stop.
2. **Chrome says so plainly.** [developer.chrome.com](https://developer.chrome.com/blog/timer-throttling-in-chrome-88),
   verbatim: _"`requestAnimationFrame` will wait for the page to be visible, so it doesn't
   use any CPU when the page is hidden."_ (The same post's timer-throttling tiers are about
   `setTimeout`, not rAF; note that a page that "has made noises in the past 30 seconds"
   escapes _intensive_ timer throttling but that does not revive rAF.)
3. **Canvas capture is driven by painting, not by a clock.** [Media Capture from DOM
   Elements](https://w3c.github.io/mediacapture-fromelement/), verbatim: _"A new frame is
   requested from the canvas when `[[frameCaptureRequested]]` is true **and the canvas is
   painted**."_

And the recorder does not stop — [MediaStream Recording](https://www.w3.org/TR/mediastream-recording/),
verbatim: _"If any Track within the `MediaStream` is muted or not enabled at any time, the
UA will only record black frames or silence."_ So a backgrounded record produces a
correct-length file full of frozen or black video.

On iOS the audio half dies too, via `InterruptionType::EnteringBackground` (§3.3). **No
primary source found** specifically distinguishing "screen locked" from "app backgrounded"
in WebKit; treat them as the same for planning.

**Design consequence:** listen for `visibilitychange` and abort the recording with a clear
message rather than shipping a broken file. Also consider a `setInterval`-driven redraw
as a belt-and-braces, but note it does not save you — a hidden document is not painted at
all, so `captureStream` still yields nothing.

### 5.2 iOS canvas size limits: 1080x1920 is nowhere near them

Straight from WebKit's [`CanvasBase.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/CanvasBase.cpp):

```cpp
static inline size_t NODELETE maxCanvasArea()
{
    ...
#if PLATFORM(IOS_FAMILY)
    return 8192 * 8192;
#else
    return 16384 * 16384;
#endif
}
```

enforced in `validateArea()`, which logs _"Canvas area exceeds the maximum limit (width \*
height > …)"_ and refuses to allocate. **iOS limit: 67,108,864 px². Our card is
1080 × 1920 = 2,073,600 px² — 3.1% of the limit.** No problem, and the same limit applies
whether we draw once or 600 times.

The often-repeated "iOS Safari caps total canvas memory at N MB" numbers: **no primary
source found.** There is no `maxActivePixelMemory`-style per-process cap in
`CanvasBase.cpp` or `ImageBuffer.cpp` in WebKit `main` as of 2026-08-18 — only the area
check above. (Older WebKit did have such a cap; if a device-specific OOM shows up in
testing, that is empirical, not documented.) Also note `shouldAccelerate()` compares the
canvas area against a `minimumAccelerated2DContextArea` setting — at 2 Mpx we are
comfortably above any plausible minimum, so the card gets an accelerated backing store.

### 5.3 File size for a 20 s 1080x1920 clip

Arithmetic, not a measurement:

| Video bitrate                              | Audio    | 20 s file |
| ------------------------------------------ | -------- | --------- |
| 2.5 Mbps (Chrome's `kDefaultVideoBitRate`) | 128 kbps | ~6.6 MB   |
| 6 Mbps                                     | 128 kbps | ~15.3 MB  |
| 8 Mbps                                     | 128 kbps | ~20.3 MB  |

All three fit Chrome's 50 MB `kMaxSharedFileBytes` and Meta's _"Under 50 MB"_
recommendation, and all fit the Content Publishing API's 100 MB Story ceiling (which we
never hit anyway). 2.5 Mbps is thin for a 1080x1920 surface with animating text; 6 Mbps is
a sane target. Set `videoBitsPerSecond` explicitly — WebKit's default is "let the platform
decide" (§1.2) and Chrome's is 2.5 Mbps.

---

## 6. Recommendation

Three options, ranked. All of them keep the still JPEG as the floor, because the JPEG path
works everywhere today and the video is an upgrade, not a replacement.

### Option A — real-time `MediaRecorder` into MP4 _(recommended first ship)_

**What it needs.** `canvas.captureStream(30)` for the animating card; `<audio>` +
`createMediaElementSource` + `MediaStreamAudioDestinationNode` (also connected to
`context.destination`) for the song; `new MediaStream([videoTrack, audioTrack])`;
`new MediaRecorder(stream, { mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
videoBitsPerSecond: 6_000_000 })`; a `requestAnimationFrame` loop that draws the card with
the lyrics advancing; `storyFileName()` extended to emit `.mp4`.

**Wait time.** Exactly the clip length — 15–20 s of real time, unavoidable. It is the song
playing, so it is at least _pleasant_ waiting; present it as a preview, not a spinner.

**Who gets it.** iOS Safari 14.3+ and macOS Safari 14.1+ (MP4 since day one, §1.2); Chrome
126+ desktop, Android and WebView (§1.3). That is effectively everyone who can share files
at all — `navigator.share({files})` itself only landed in Safari 14 and Chrome Android 76.
Chrome below 126 can still get `video/webm;codecs=vp8,opus`, but see §2.3 for why that is
an unproven bet; simplest is to fall back to the JPEG.

**Fallback.** `MediaRecorder.isTypeSupported('video/mp4…')` false, or no
`MediaRecorder`, or `navigator.canShare({files:[mp4Probe]})` false → today's JPEG, with the
existing "Story"/"Card" caption logic. Backgrounding mid-record → abort, keep the JPEG.

**New dependency.** **None.** This is the decisive advantage.

**Strict-CSP shared page.** **Works unchanged.** Nothing in this path makes a network
request: the `<audio>` element is already loaded under `media-src 'self'`, the canvas is
already painted, and `MediaRecorder` produces a `Blob` in memory. The compiled inline
script grows by the recording code only. (One caveat: if we want to show the person a
`<video>` preview of the result from a `blob:` URL, that load _is_ governed by `media-src`
and would need `media-src 'self' blob:`. Sharing the `File` directly needs no such change.)

### Option B — WebCodecs + `mp4-muxer`, faster-than-real-time

**What it needs.** `VideoEncoder` (avc1, even dimensions) fed `VideoFrame`s drawn from the
card; `AudioEncoder` (mp4a.40.2) fed `AudioData` decoded from the MP3; `mp4-muxer` to
assemble the MP4; and **audio bytes**, which on the shared page means either adding
`connect-src 'self'` (recommended) or the nonced-script / inlined-base64 routes in §4.4.

**Wait time.** Unknown — **no primary benchmark exists** (§4.5). Plausibly a few seconds,
but we would have to measure before promising it.

**Who gets it.** Chrome 94+ on desktop and Android, and **Safari 26+ only** — because
`AudioEncoder` did not exist in WebKit before Safari 26 (§4.1). Every iPhone on iOS
16.4–18.x can encode the video but not the audio. Desktop Linux Chrome has no AAC encoder
either. That is a large fraction of the audience getting nothing, or a silent clip.
(The one polyfill for this, `@mediabunny/aac-encoder`, is itself CSP-blocked on the shared
page — §4.3.)

**Fallback.** Option A, then the JPEG. Which means Option B is strictly _additional_ code,
not replacement code.

**New dependency.** Yes — `mp4-muxer` (MIT, 14.9 KB gzip, zero runtime deps, inlinable
IIFE, no Workers, no wasm, no fetch) or a vendored copy of it, given its npm deprecation
notice. Against `AGENTS.md`'s "small and audited" bar it is a defensible candidate;
`mediabunny` at ~168 KB gzip, MPL-2.0, with four `new Worker(blob:)` call sites, is not.

**Strict-CSP shared page.** Works only with one of: `connect-src 'self'` added, or audio
bytes delivered via a nonced `<script src>`, or bytes inlined in the HTML. The `mp4-muxer`
muxer itself is fine — it needs no worker, no wasm and no fetch (§4.3).

**Verdict: not first.** Build it later, behind a capability probe, once Option A is shipped
and once someone has actually measured the encode on a mid-range phone.

### Option C — server-side render in the Worker

**What it needs.** A Cloudflare-side render of the 20 s clip, with the browser only asking
for it and handing the resulting file to `navigator.share`. Not researched here in depth,
and it collides with two standing commitments: Cloudflare Workers have no FFmpeg and
Mini Mehfil deliberately keeps generation costs explicit and user-initiated (`AGENTS.md`,
`PRODUCT.md`). Recorded only so the option is on the page; **not recommended.**

### The order to build in

1. Extend `src/shared/story-card.ts` so `storyFileName()` takes an extension, and add the
   per-frame lyric state the animation needs (it is a pure decision, so it belongs there,
   beside `storyStanza`).
2. Add a `recordStoryCard()` alongside `storyCardBlob()` in
   `src/client/shared/story-card-canvas.ts`, guarded by a `canRecordStoryCard()` probe in
   the same shape as the existing `canShareStoryCard()`. Keep it import-free so
   `scripts/build-story-card.ts` keeps working.
3. Wire it into the host app's story button and the shared page's, with the JPEG as the
   fallback in both.
4. Only then, and only with device measurements in hand, consider Option B.

---

## Confidence and gaps

**High confidence (vendor source or vendor release notes read directly):**
Safari's MediaRecorder container and codec allowlists; Chrome's container and codec
allowlists and the case-sensitivity of `video/mp4`; Chrome's MP4 ship in 126 across
desktop/Android/WebView; Safari's MP4 support since iOS 14.3; Safari's WebM output since
18.4; WebCodecs `AudioEncoder` only from Safari 26; WebKit's `avc1` even-dimension rule;
Chrome's 50 MB / 10-file share cap; Chromium's Web Share extension and MIME allowlists
(`.mp4` and `.webm` both permitted, `.mov` not); WebKit having no Web Share type allowlist;
iOS deriving the share UTI from the filename extension; the iOS 8192×8192 canvas area
limit; which CSP directive governs `fetch` vs `<audio>`; the Web Audio re-routing and
CORS-silence rules; rAF stopping on hidden documents; the measured sizes, licenses and
dependency counts of `mp4-muxer` and `mediabunny`; ffmpeg.wasm's fetch and module-Worker
requirements.

**Medium confidence (spec-derived reasoning rather than a vendor statement):**
That `new Worker()` cannot be nonce-allowed under `script-src 'nonce-X'` — derived from
CSP3 §6.7.2.5 plus the fallback list, not from a vendor doc. That the Sharing-to-Stories
format list describes the app's ingestion capability generally rather than only that one
entry point. That Chrome Android may report `avc1` unsupported on devices whose MediaCodec
lacks an H.264 encoder — assembled from the Chromium issue tracker and chromestatus rather
than one statement.

**Gaps — no primary source found, do not fill these in with plausible claims:**

- Any exact `MediaRecorder.isTypeSupported()` truth table for any shipped Safari build.
  The tables in §1.2 come from WebKit `main`. Probe on device.
- What the Instagram iOS app declares in `NSExtensionActivationRule` / accepted UTIs, and
  therefore whether a `.webm` file is even offered to it.
- Any Meta documentation of the OS share-sheet ingestion path at all.
- Any evidence, primary or credible, that Instagram rejects WebM from the share sheet.
- Any `navigator.share` file-size or file-count limit on iOS/WebKit.
- Any benchmark of WebCodecs encode throughput for 1080x1920 on a phone, from anyone.
- WebKit behaviour on screen lock specifically, as distinct from app backgrounding.
- Any current per-process canvas memory cap on iOS beyond the area check.
- Whether `mediabunny`'s plain `Output` / `Mp4OutputFormat` mux path touches any of its
  four `blob:` Worker sites (its `src/misc.ts` unthrottled-timer helper could not be
  traced to its callers).
- Any per-browser table of H.264 _encoder_ support; MDN publishes decoder percentages only.

**The one experiment that would settle the most:** build the Option A recorder behind a
flag, produce a 20 s 1080x1920 MP4 on a real iPhone and a real Android phone, and put it
through the share sheet into Instagram Stories. That single test answers the Instagram
question, the UTI question and the encode-quality question at once, and none of them can be
answered from documents.
