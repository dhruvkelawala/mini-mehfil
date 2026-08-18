# Section timing contract

How lyric timing works, what the UI promises, and what is allowed to persist.
This document is a binding product contract (see `AGENTS.md`): change it and
the code together or not at all.

## Analysis is non-blocking

Once Music 3 finishes, the proxy returns the paid recording immediately and the
host starts playback. The browser then makes a separate request to MiniMax's
free `music_cover_preprocess` endpoint with the same request-only key to learn
where the song's sections fall. Each background attempt has a three-minute
ceiling, with at most two attempts and retries limited to timeout, network,
provider-busy, 408/429 and 5xx failures. A slow or failed optional analysis can
never hold the finished song hostage.

## Pending, timed, and fallback modes

While analysis is pending the performance says exactly
`Analyzing MiniMax sections · music is ready`. When a trusted artifact arrives
and lines up with the written sections and media duration, the already-playing
recording upgrades at its current clock without reload, restart or seek. The
reveal follows those sections while a syllable-weighted display heuristic paces
the current-line emphasis inside each one. Timed mode says exactly
`Lines follow MiniMax sections · timing is approximate`: provider truth stops
at the section boundaries, and nothing here is line, word, or karaoke timing.
Terminal failures and weak mappings keep the existing Atmospheric reveal.

## Save is immediate; publication waits

Save remains immediate. A requested standalone share or live-room publication
waits for analysis to become ready or terminal while private playback
continues, then carries either the same normalized immutable timing artifact or
an explicit untimed result. Host, live listener and standalone shared playback
derive active sections and lines from that same artifact and media clock; old
rooms and shares without timing remain compatible.

## Vocal-entry hold

For inline audio bytes, the host also makes one best-effort, band-limited onset
check and holds the first section's sung lines until the likely vocal entry.
That release is also the first section's line-pacing origin; if analysis
finishes late, pacing starts at the media clock where the hold is released so
hidden intervals cannot skip the opening lines. Provider section boundaries
remain unchanged. Remote audio URLs and shared pages skip that gate; playback
never waits for it. Both line pacing and the vocal-entry gate are approximate
render-time heuristics.

## Only section boundaries persist

Nothing from provider analysis is kept except normalized section boundaries;
transcripts, trace identifiers, feature identifiers, signed URLs and derived
pacing never enter the persisted timing artifact.
