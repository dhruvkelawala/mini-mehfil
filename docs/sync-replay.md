# Sync-replay: the no-cost real-media loop

`pnpm run test:sync-replay` verifies host, live-listener, and standalone shared
playback against a real saved MP3 without spending money. It discovers the
fixture named in `test/fixtures/sync-replay-song.json` in `~/Downloads`, or
accepts an explicit file:

```bash
pnpm run test:sync-replay -- /absolute/path/to/song.mp3
```

The browser never intercepts generation or timing responses in this mode. The
normal Node proxy talks to an in-process MiniMax stub, which serves the local
MP3 with byte-range support and holds timing until the test explicitly releases
it. The test then samples the same media clock on the host, live-listener, and
standalone shared surfaces — including a backward seek — and requires exactly
one generation, timing, and share request. It clears `MINIMAX_API_TOKEN`, so it
cannot make a paid call. A combined proof video is written to
`.claude/artifacts/sync-replay/sync-replay-proof.webm`.

The checked-in sidecar currently verifies transport, late upgrade, seeking, and
three-surface parity; `audiblyVerified` is deliberately false because the
downloaded MP3 contains no embedded lyric sheet. Replace its lyric text and
section timestamps with a human-checked transcription before treating the
replay as evidence of audible lyric alignment.
