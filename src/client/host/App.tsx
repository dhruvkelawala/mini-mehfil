/* eslint-disable solid/no-innerhtml */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';

import {
  activePacedLine,
  buildLinePacing,
  effectiveFirstVocalRelease,
  type PacedLine,
} from '../../lyrics/line-pacing.ts';
import {
  activeTimelineEntry,
  buildSectionTimeline,
  parseLyricSheet,
  type LyricLine,
  type LyricSection,
} from '../../lyrics/lyric-sync.ts';
import type { LyricsSheet, SongRequest } from '../../room/protocol.ts';
import { COURTYARD_SCENE } from '../../worker/courtyard.ts';
import {
  createGenerationController,
  type GeneratedSong,
} from './generation-controller.ts';
import {
  createHostRoomController,
  roomReorderTargets,
} from './host-room-controller.ts';
import { createMediaDiagnostics } from './media-diagnostics.ts';
import { createPlayerController } from './player-controller.ts';
import {
  detectVocalEntry,
  reconcileVocalAnalysisResult,
  vocalAnalysisRelease,
  vocalGateSeconds,
  type VocalAnalysisResult,
} from './vocal-onset.ts';

const languages = [
  'auto',
  'Gujarati',
  'Hindi',
  'Punjabi',
  'Tamil',
  'Bengali',
  'Marathi',
  'Urdu',
  'English',
  'Spanish',
  'French',
  'Arabic',
  'Japanese',
  'Korean',
];
const formatTime = (seconds: number) =>
  Number.isFinite(seconds)
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
    : '0:00';
/**
 * One rendered lyric line. Shared by the untimed reveal and both timed views so
 * they cannot drift apart in markup.
 */
const LyricLineView = (props: {
  line: LyricLine;
  hidden?: boolean;
  current?: boolean;
  upcoming?: boolean;
}) => (
  <span
    classList={{
      'lyric-line': true,
      'lyric-cue': props.line.cue,
      'lyric-line-current': props.current,
      'lyric-line-upcoming': props.upcoming,
    }}
    hidden={props.hidden}
    aria-current={props.current ? 'true' : undefined}
  >
    <Show when={!props.line.cue} fallback={props.line.primary}>
      <span class="lyric-primary">{props.line.primary}</span>
      <Show when={props.line.secondary}>
        <span class="lyric-secondary">{props.line.secondary}</span>
      </Show>
    </Show>
  </span>
);
/** Stable timed-section markup; line emphasis updates without replacing it. */
export const TimedSectionView = (props: {
  section: LyricSection;
  activeLine: PacedLine | null;
  holdLines: boolean;
}) => (
  <span class="lyric-section lyric-section-current">
    <For
      each={props.section.lines.filter((line) => !props.holdLines || line.cue)}
    >
      {(line, index) => {
        const lineIndex = () => props.section.lines.indexOf(line) ?? index();
        const current = () =>
          !line.cue &&
          props.activeLine?.sectionIndex === props.section.index &&
          props.activeLine.lineIndexInSection === lineIndex();
        const upcoming = () =>
          Boolean(
            !line.cue &&
            props.activeLine &&
            props.activeLine.sectionIndex === props.section.index &&
            lineIndex() > props.activeLine.lineIndexInSection,
          );
        return (
          <LyricLineView
            line={line}
            current={current()}
            upcoming={upcoming()}
          />
        );
      }}
    </For>
  </span>
);
const publicLyrics = (sheet: LyricsSheet): LyricsSheet => ({
  title: sheet.title,
  language: sheet.language,
  nativeScriptName: sheet.nativeScriptName,
  isLatinScript: sheet.isLatinScript,
  lyricsNative: sheet.lyricsNative,
  lyricsRoman: sheet.lyricsRoman,
});
const TOKEN_REQUIRED_MESSAGE =
  'Paste your MiniMax token before queueing a recording.';

export function App() {
  const diagnostics = createMediaDiagnostics();
  const player = createPlayerController(diagnostics);
  const room = createHostRoomController();
  const generation = createGenerationController({ player });
  const [performanceOpen, setPerformanceOpen] = createSignal(false);
  const [manualLyricsOpen, setManualLyricsOpen] = createSignal(false);
  const [shareLabel, setShareLabel] = createSignal('Share');
  const [tokenVisible, setTokenVisible] = createSignal(false);
  const [hasToken, setHasToken] = createSignal(false);
  const [roomError, setRoomError] = createSignal('');
  const [vocalAnalysisResult, setVocalAnalysisResult] =
    createSignal<VocalAnalysisResult | null>(null);
  const [clock, setClock] = createSignal('--:--');
  const [idea, setIdea] = createSignal('');
  const [vibe, setVibe] = createSignal('');
  const [language, setLanguage] = createSignal('auto');
  let tokenInput: HTMLInputElement | undefined;
  let performanceDialog: HTMLElement | undefined;
  let performanceOpener: HTMLElement | null = null;

  const activeLyrics = createMemo(
    () => room.currentSong()?.lyrics ?? generation.lyrics(),
  );
  const lyricSheet = createMemo(() => parseLyricSheet(activeLyrics()));
  const lyricLines = createMemo(() => lyricSheet().lines);
  /**
   * Non-null only when this recording's own section analysis maps onto the
   * written sections. Everything below reads the media clock through it — no
   * timers, no cursors — so seeking backwards is as correct as playing forward.
   */
  const sectionTimeline = createMemo(() =>
    buildSectionTimeline(lyricSheet().sections, player.timing()),
  );
  const activeEntry = createMemo(() =>
    activeTimelineEntry(sectionTimeline(), player.currentTime()),
  );
  const firstVocalEntry = createMemo(() =>
    sectionTimeline()?.find(
      (entry) =>
        entry.sectionIndex !== null &&
        entry.label !== 'inst' &&
        entry.label !== 'silence',
    ),
  );
  /**
   * `undefined` means same-origin analysis is pending, `null` means the clean
   * no-gate path, and a number is the fixed gate/pacing release origin.
   * Matching result inputs keep a prior song's async result from flashing.
   */
  const vocalRelease = createMemo<number | null | undefined>(() => {
    const bytes = player.analysisBytes();
    const timeline = sectionTimeline();
    return vocalAnalysisRelease(
      vocalAnalysisResult(),
      player.source(),
      timeline,
      Boolean(bytes && timeline && firstVocalEntry()),
    );
  });
  const linePacing = createMemo(() =>
    buildLinePacing(lyricSheet().sections, sectionTimeline(), vocalRelease()),
  );
  const activeLine = createMemo(() =>
    activePacedLine(linePacing(), player.currentTime()),
  );
  const activeSection = createMemo(() => {
    const index = activeEntry()?.sectionIndex;
    return typeof index === 'number'
      ? lyricSheet().sections.find((section) => section.index === index)
      : undefined;
  });
  const restLabel = createMemo(() => {
    const entry = activeEntry();
    if (!entry || entry.sectionIndex !== null) return '';
    if (entry.label === 'inst') return 'Instrumental';
    return entry.label === 'silence' ? 'Pause' : '';
  });
  const firstVocalLinesHeld = createMemo(() => {
    const active = activeEntry();
    const first = firstVocalEntry();
    if (
      !active ||
      !first ||
      active.start !== first.start ||
      active.end !== first.end ||
      active.sectionIndex !== first.sectionIndex
    )
      return false;
    const release = vocalRelease();
    return (
      release === undefined ||
      (release !== null && player.currentTime() < release)
    );
  });
  /** A ready recording owns the preview through play, pause, end, and reopen. */
  const playbackPreviewActive = createMemo(
    () => player.ready() && Boolean(activeLyrics()),
  );
  const manualRevealActive = createMemo(
    () => manualLyricsOpen() && !playbackPreviewActive(),
  );
  const shownSpoken = createMemo(() => {
    if (manualRevealActive() || !player.duration())
      return Number.POSITIVE_INFINITY;
    const spoken = lyricLines().filter((line) => !line.cue).length;
    return Math.ceil(
      Math.min(player.currentTime() / (player.duration() * 0.9), 1) * spoken,
    );
  });
  const languageLabel = createMemo(() => {
    const sheet = activeLyrics();
    if (!sheet) return '';
    return sheet.isLatinScript
      ? sheet.language
      : `${sheet.language} · ${sheet.nativeScriptName}`;
  });
  const requestQueue = createMemo(() =>
    room
      .view()
      .queue.filter(
        (item) =>
          item.status === 'pending' ||
          item.status === 'accepted' ||
          item.status === 'failed',
      ),
  );
  const recordingQueue = createMemo(() => {
    const state = room.snapshot();
    const byId = new Map(room.view().queue.map((item) => [item.id, item]));
    return (state?.recordingQueue ?? [])
      .map((requestId) => byId.get(requestId))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  });
  const currentRecording = createMemo(() => {
    const requestId = room.snapshot()?.currentRecording?.requestId;
    return room.view().queue.find((item) => item.id === requestId) ?? null;
  });
  const performanceAvailable = createMemo(
    () => generation.performanceAvailable() || player.ready(),
  );

  const openPerformance = (opener?: HTMLElement | null) => {
    if (!performanceAvailable()) return;
    performanceOpener =
      opener ?? (document.activeElement as HTMLElement | null);
    setPerformanceOpen(true);
    queueMicrotask(() =>
      performanceDialog
        ?.querySelector<HTMLElement>('.performance-close')
        ?.focus(),
    );
  };
  const closePerformance = () => {
    setPerformanceOpen(false);
    performanceOpener?.focus();
  };
  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const field = document.createElement('textarea');
      field.value = url;
      field.readOnly = true;
      Object.assign(field.style, { position: 'fixed', opacity: '0' });
      document.body.append(field);
      field.select();
      if (!document.execCommand('copy'))
        throw new Error('Copy the link from the field.');
      field.remove();
    }
  };
  const publishStandalone = async (song: GeneratedSong) => {
    if (!room.details()) return;
    if (!room.authenticated())
      throw new Error(
        'Your recording is ready, but the live room is reconnecting. Try sharing it again once connected.',
      );
    const result = await generation.share(false, song);
    if (
      !result ||
      !room.publishStandalone(result.url, publicLyrics(song.lyricSheet))
    )
      throw new Error(
        'Your recording is ready, but the live room lost its connection.',
      );
  };
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!tokenInput) return;
    setRoomError('');
    setManualLyricsOpen(false);
    setPerformanceOpen(true);
    setShareLabel('Share');
    try {
      await generation.generate(
        {
          token: tokenInput.value,
          idea: idea(),
          vibe: vibe(),
          language: language(),
        },
        room.details() ? { onReady: publishStandalone } : {},
      );
    } catch {
      /* Controller owns visible generation errors. */
    }
  };
  const share = async () => {
    setShareLabel('Sharing');
    try {
      const url = await generation.share(true);
      setShareLabel(url?.copied ? 'Copied' : url ? 'Link ready' : 'Share');
    } catch (error) {
      setShareLabel('Retry');
      setRoomError(error instanceof Error ? error.message : 'Sharing failed.');
    }
  };
  const recordRequest = (item: SongRequest) => {
    if (!hasToken() || !tokenInput?.value.trim()) {
      setRoomError(TOKEN_REQUIRED_MESSAGE);
      tokenInput?.focus();
      return;
    }
    if (!room.enqueueRecording(item.id)) {
      setRoomError(
        'The room is reconnecting. Wait for it to reconnect, then press Record again.',
      );
      return;
    }
    setRoomError('');
  };

  const roomGenerationHooks = (requestId: string) => {
    const context = {
      kind: 'room-recording' as const,
      roomId: room.details()?.roomId ?? '',
      requestId,
    };
    return {
      context,
      onLyrics: (sheet: LyricsSheet) =>
        room.send({
          type: 'lyrics-ready',
          requestId,
          lyrics: publicLyrics(sheet),
        }),
      onReady: async (song: GeneratedSong) => {
        const result = await generation.share(false, song);
        const match = result
          ? /\/s\/([A-Za-z0-9_-]{16})$/.exec(new URL(result.url).pathname)
          : null;
        if (!match?.[1])
          throw new Error('The share service returned an invalid link.');
        if (!room.send({ type: 'song-ready', requestId, shareId: match[1] }))
          throw new Error('The live room lost its connection.');
      },
      onFailed: () => {
        processingRoomRequest = '';
        room.send({ type: 'recording-failed', requestId });
      },
    };
  };

  let processingRoomRequest = '';
  createEffect(() => {
    const state = room.snapshot();
    const details = room.details();
    const authenticated = room.authenticated();
    const generating = generation.generating();
    const tokenReady = hasToken();
    if (!state || !details || !authenticated || room.terminal()) return;
    const pending = generation.pendingContext();
    if (
      pending?.kind === 'room-recording' &&
      pending.roomId === details.roomId
    ) {
      const request = state.queue.find(
        (candidate) => candidate.id === pending.requestId,
      );
      if (request?.status === 'ready' || request?.status === 'failed') {
        generation.acknowledgeRoomOutcome(details.roomId, pending.requestId);
      }
    }
    const recording = state.currentRecording;
    if (!recording) {
      processingRoomRequest = '';
      if (
        !generating &&
        tokenReady &&
        tokenInput?.value.trim() &&
        state.recordingQueue[0]
      ) {
        room.send({
          type: 'recording-started',
          requestId: state.recordingQueue[0],
          coordinatorId: room.coordinatorId(),
        });
      }
      return;
    }
    if (recording.coordinatorId !== room.coordinatorId()) return;
    if (processingRoomRequest === recording.requestId) return;
    const item = state.queue.find(
      (candidate) => candidate.id === recording.requestId,
    );
    if (!item || !tokenReady || !tokenInput?.value.trim()) return;
    const hooks = roomGenerationHooks(item.id);
    const recoveryContext = generation.pendingContext();
    if (recoveryContext) {
      if (
        recoveryContext.kind !== 'room-recording' ||
        recoveryContext.roomId !== details.roomId ||
        recoveryContext.requestId !== item.id
      ) {
        setRoomError(
          'Another recording is still recovering in this tab. Finish checking it before this queue continues.',
        );
        return;
      }
      processingRoomRequest = item.id;
      generation.resumePending('page-load', hooks);
      return;
    }
    if (generating) return;
    processingRoomRequest = item.id;
    void generation
      .generate(
        {
          token: tokenInput.value,
          idea: item.idea,
          vibe: item.vibe,
          language: item.language || 'auto',
        },
        hooks,
      )
      .catch(() => {
        /* The generation hooks advance the authoritative queue. */
      });
  });
  const togglePlayback = async () => {
    const song = room.currentSong();
    if (song) {
      if (
        !room.send({
          type: 'playback-updated',
          shareId: song.shareId,
          status: player.playing() ? 'paused' : 'playing',
          positionMs: player.ended() ? 0 : player.currentTime() * 1000,
        })
      ) {
        setRoomError('The room is reconnecting. Playback did not change.');
      }
      return;
    }
    await player.toggle();
  };
  createEffect(() => {
    const song = room.currentSong();
    const details = room.details();
    if (!song || !details) return;
    if (!player.source().includes(`/s/${song.shareId}/audio`))
      player.loadRoomSong(song, new URL(details.joinUrl).origin);
    player.syncRoomSong(song);
  });
  let vocalAnalysisRun = 0;
  createEffect(() => {
    const bytes = player.analysisBytes();
    const source = player.source();
    const timeline = sectionTimeline();
    const first = firstVocalEntry();
    const eligible = Boolean(bytes && timeline && first);
    const run = ++vocalAnalysisRun;
    setVocalAnalysisResult((result) =>
      reconcileVocalAnalysisResult(result, source, timeline, eligible),
    );
    if (!bytes || !timeline || !first) return;
    void detectVocalEntry(bytes, Math.max(0, first.start - 1), first.end).then(
      (onset) => {
        if (run !== vocalAnalysisRun) return;
        const gate = vocalGateSeconds(timeline, onset);
        setVocalAnalysisResult({
          source,
          timeline,
          release: effectiveFirstVocalRelease(
            timeline,
            gate,
            player.currentTime(),
          ),
        });
      },
    );
  });
  createEffect(() => {
    document.body.classList.toggle('performance-open', performanceOpen());
  });

  onMount(() => {
    const updateClock = () =>
      setClock(
        new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' })
          .format(new Date())
          .toLowerCase(),
      );
    updateClock();
    const clockTimer = setInterval(updateClock, 30_000);
    const pagehide = () => generation.lifecycleBackgrounded();
    const pageshow = () => {
      generation.lifecycleForegrounded();
      if (generation.resumePending()) setPerformanceOpen(true);
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden')
        generation.lifecycleBackgrounded();
      else {
        generation.lifecycleForegrounded();
        if (generation.resumePending()) setPerformanceOpen(true);
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (!performanceOpen()) return;
      if (event.key === 'Escape') {
        closePerformance();
        return;
      }
      if (event.key !== 'Tab' || !performanceDialog) return;
      const controls = [
        ...performanceDialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href]:not([aria-disabled="true"])',
        ),
      ].filter((element) => !element.hidden);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('keydown', keydown);
    if (generation.resumePending()) setPerformanceOpen(true);
    onCleanup(() => {
      clearInterval(clockTimer);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', pageshow);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('keydown', keydown);
    });
  });

  return (
    <>
      {/* Repository-owned static SVG; never contains user input. */}
      <div
        class={`scene-root ${generation.generating() || player.playing() ? 'is-performing' : ''}`}
        aria-hidden="true"
        innerHTML={COURTYARD_SCENE}
      />
      <div class="grain" aria-hidden="true" />
      <header class="topbar" inert={performanceOpen()}>
        <div class="time" id="clock">
          {clock()}
        </div>
        <div class="live">
          <i />
          <span>music-3.0</span>
        </div>
        <div class="topbar-actions">
          <button
            id="open-room"
            class={`room-open ${room.details() ? 'is-live' : ''}`}
            type="button"
            disabled={room.opening()}
            aria-label={
              room.details()
                ? `Manage live mehfil, ${room.listenerCount()} listener${room.listenerCount() === 1 ? '' : 's'}`
                : 'Open this mehfil to friends'
            }
            aria-controls="room-panel"
            aria-expanded={room.panelOpen()}
            onClick={() =>
              void room
                .open()
                .catch((error: unknown) =>
                  setRoomError(
                    error instanceof Error
                      ? error.message
                      : 'The room could not be opened.',
                  ),
                )
            }
          >
            <span id="room-open-label">
              <span class="room-open-wide">
                {room.opening()
                  ? 'Opening…'
                  : room.status() === 'reconnecting'
                    ? 'Reconnecting…'
                    : room.details()
                      ? `Live · ${room.listenerCount()}`
                      : 'Invite friends'}
              </span>
              <span class="room-open-compact">
                {room.details() ? `Live · ${room.listenerCount()}` : 'Invite'}
              </span>
            </span>
          </button>
          <a
            href="https://platform.minimax.io/docs/api-reference/music-generation"
            target="_blank"
            rel="noreferrer"
          >
            API docs <span>↗</span>
          </a>
        </div>
      </header>
      <main inert={performanceOpen()}>
        <section class="identity" aria-labelledby="brand-title">
          <h1 id="brand-title" aria-label="Mini Mehfil">
            <span class="mini" aria-hidden="true">
              Mini
            </span>
            महफ़िल
          </h1>
          <p class="tagline">
            A private song room. Write the words, set the mood, let them sing.
          </p>
        </section>
        <form
          id="song-form"
          class="composer"
          onSubmit={(event) => void submit(event)}
        >
          <div class="composer-head">
            <h2>Make a song</h2>
            <span class="price">≈ $0.15</span>
          </div>
          <label class="field token-field">
            <span>MiniMax token</span>
            <div class="input-wrap">
              <input
                ref={(element) => {
                  tokenInput = element;
                }}
                id="token"
                name="token"
                type={tokenVisible() ? 'text' : 'password'}
                autocomplete="off"
                spellcheck={false}
                placeholder="sk-cp-••••••••"
                required
                disabled={generation.generating()}
                onInput={(event) => {
                  const ready = Boolean(event.currentTarget.value.trim());
                  setHasToken(ready);
                  if (ready && roomError() === TOKEN_REQUIRED_MESSAGE)
                    setRoomError('');
                }}
              />
              <button
                type="button"
                id="reveal-token"
                class="reveal"
                aria-label={`${tokenVisible() ? 'Hide' : 'Show'} token`}
                aria-pressed={tokenVisible()}
                onClick={() => setTokenVisible(!tokenVisible())}
              >
                {tokenVisible() ? 'Hide' : 'Show'}
              </button>
            </div>
            <small>Used for this request only. Never saved.</small>
          </label>
          <label class="field">
            <span>What's the song about?</span>
            <input
              id="idea"
              name="idea"
              type="text"
              maxlength="400"
              required
              placeholder="Aloopuri Khavsa"
              value={idea()}
              onInput={(event) => setIdea(event.currentTarget.value)}
              disabled={generation.generating()}
            />
            <small>
              Any language, typed however you type. We'll figure out the rest.
            </small>
          </label>
          <div class="field-row">
            <label class="field">
              <span>
                Vibe <em>optional</em>
              </span>
              <input
                id="vibe"
                name="vibe"
                type="text"
                maxlength="400"
                placeholder="hip hop, upbeat"
                value={vibe()}
                onInput={(event) => setVibe(event.currentTarget.value)}
                disabled={generation.generating()}
              />
            </label>
            <label class="field">
              <span>Language</span>
              <select
                id="language"
                name="language"
                value={language()}
                onChange={(event) => setLanguage(event.currentTarget.value)}
                disabled={generation.generating()}
              >
                <For each={languages}>
                  {(item) => (
                    <option value={item}>
                      {item === 'auto' ? 'Auto-detect' : item}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </div>
          <div
            id="notice"
            class={`notice ${generation.statusWorking() ? 'working' : ''}`}
            role="status"
            aria-live="polite"
            aria-hidden={performanceOpen() ? 'true' : undefined}
          >
            {roomError() || generation.status()}
          </div>
          <button
            class="generate"
            type="submit"
            disabled={generation.generating()}
          >
            <span class="button-label">
              {generation.generating()
                ? 'Making your song…'
                : 'Start the mehfil'}
            </span>
            <span class="arrow">→</span>
          </button>
          <p class="cost-hint" id="cost-hint">
            Lyrics cost about a tenth of a cent. The song costs ≈ $0.15.
          </p>
        </form>
        <Show when={room.details() && room.panelOpen()}>
          <aside
            id="room-panel"
            class="room-panel"
            aria-labelledby="room-heading"
          >
            <div class="room-panel-head">
              <h2 id="room-heading" tabIndex={-1}>
                Live mehfil
              </h2>
              <div class="room-panel-tools">
                <span id="room-state">{room.status()}</span>
                <button
                  id="dismiss-room"
                  class="room-dismiss"
                  type="button"
                  aria-label="Hide live mehfil controls"
                  onClick={() => room.showPanel(false)}
                >
                  ×
                </button>
              </div>
            </div>
            <p>
              Room <strong id="room-code">{room.details()?.roomId}</strong> ·{' '}
              <span id="room-presence">
                {room.listenerCount()} listener
                {room.listenerCount() === 1 ? '' : 's'}
              </span>
            </p>
            <div class="room-link-row">
              <input
                id="room-link"
                readonly
                value={room.details()?.joinUrl ?? ''}
                aria-label="Listener join link"
              />
              <button
                id="copy-room"
                type="button"
                onClick={() => void copyLink(room.details()?.joinUrl ?? '')}
              >
                Copy link
              </button>
            </div>
            <p
              id="room-message"
              class="room-message"
              role="status"
              aria-live="polite"
            >
              {room.message()}
            </p>
            <Show when={room.currentSong()}>
              <div id="room-playback" class="room-playback">
                <div>
                  <strong id="room-playback-state">
                    {room.currentSong()?.playback.status === 'playing'
                      ? 'Playing'
                      : 'Paused'}
                  </strong>
                  <span>Shared playback</span>
                </div>
                <p>Your player controls the music for everyone in this room.</p>
              </div>
            </Show>
            <h3>Listeners</h3>
            <ul id="host-participants" class="host-participants">
              <For each={room.view().participants}>
                {(participant) => (
                  <li>
                    {participant.name}
                    <button
                      type="button"
                      onClick={() => room.kick(participant.id)}
                    >
                      Kick
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <h3>Requests</h3>
            <ol id="host-queue" class="host-queue" aria-label="Request queue">
              <For each={requestQueue()}>
                {(item) => {
                  const targets = () =>
                    roomReorderTargets(room.snapshot()?.queue ?? [], item.id);
                  return (
                    <li>
                      {item.requesterName}: {item.idea} · {item.status}
                      <br />
                      <Show when={item.status === 'pending'}>
                        <button
                          type="button"
                          onClick={() => room.accept(item.id)}
                        >
                          Accept
                        </button>
                      </Show>
                      <Show
                        when={
                          item.status === 'pending' ||
                          item.status === 'accepted'
                        }
                      >
                        <button
                          type="button"
                          aria-label={`Move ${item.idea} up`}
                          onClick={() => room.reorder(item.id, targets().up)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${item.idea} down`}
                          onClick={() => room.reorder(item.id, targets().down)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => room.decline(item.id)}
                        >
                          Decline
                        </button>
                      </Show>
                      <Show
                        when={
                          item.status === 'accepted' || item.status === 'failed'
                        }
                      >
                        <button
                          type="button"
                          onClick={() => recordRequest(item)}
                        >
                          {item.status === 'failed' ? 'Retry' : 'Record'}
                        </button>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ol>
            <div
              class="recording-workflow"
              aria-live="polite"
              aria-atomic="true"
            >
              <Show when={currentRecording()}>
                {(item) => (
                  <section class="recording-now" aria-label="Recording now">
                    <div class="recording-section-heading">
                      <h3>
                        <span class="recording-pulse" aria-hidden="true" />
                        Recording now
                      </h3>
                      <span>In progress</span>
                    </div>
                    <p class="recording-track">
                      <strong>{item().idea}</strong>
                      <span>Requested by {item().requesterName}</span>
                    </p>
                  </section>
                )}
              </Show>
              <Show when={recordingQueue().length > 0}>
                <section class="recording-up-next" aria-label="Up next">
                  <div class="recording-section-heading">
                    <h3>Up next</h3>
                    <span>
                      {recordingQueue().length}{' '}
                      {recordingQueue().length === 1 ? 'song' : 'songs'}
                    </span>
                  </div>
                  <ol>
                    <For each={recordingQueue()}>
                      {(item, index) => (
                        <li>
                          <span class="recording-position" aria-hidden="true">
                            {index() + 1}
                          </span>
                          <span class="recording-copy">
                            <strong>{item.idea}</strong>
                            <small>Requested by {item.requesterName}</small>
                          </span>
                          <span class="recording-actions">
                            <Show when={index() > 0}>
                              <button
                                type="button"
                                title="Move up"
                                aria-label={`Move ${item.idea} up in recording queue`}
                                onClick={() =>
                                  room.reorderRecording(item.id, index() - 1)
                                }
                              >
                                <svg viewBox="0 0 18 18" aria-hidden="true">
                                  <path d="m4.5 9 4.5-4.5L13.5 9M9 4.5v9" />
                                </svg>
                              </button>
                            </Show>
                            <Show when={index() < recordingQueue().length - 1}>
                              <button
                                type="button"
                                title="Move down"
                                aria-label={`Move ${item.idea} down in recording queue`}
                                onClick={() =>
                                  room.reorderRecording(item.id, index() + 1)
                                }
                              >
                                <svg viewBox="0 0 18 18" aria-hidden="true">
                                  <path d="m4.5 9 4.5 4.5L13.5 9M9 13.5v-9" />
                                </svg>
                              </button>
                            </Show>
                            <button
                              class="recording-remove"
                              type="button"
                              title="Remove from queue"
                              aria-label={`Remove ${item.idea} from recording queue`}
                              onClick={() => room.removeRecording(item.id)}
                            >
                              <svg viewBox="0 0 18 18" aria-hidden="true">
                                <path d="m5 5 8 8M13 5l-8 8" />
                              </svg>
                            </button>
                          </span>
                        </li>
                      )}
                    </For>
                  </ol>
                </section>
              </Show>
            </div>
            <h3>Setlist</h3>
            <ol id="host-setlist" class="host-setlist">
              <For each={room.view().setlist}>
                {(song, index) => {
                  const isCurrent = () =>
                    room.currentSong()?.shareId === song.shareId;

                  return (
                    <li classList={{ 'is-current': isCurrent() }}>
                      <span class="setlist-position" aria-hidden="true">
                        {index() + 1}
                      </span>
                      <span class="setlist-copy">
                        <a href={song.url} target="_blank" rel="noreferrer">
                          {song.title}
                        </a>
                        <small>
                          {isCurrent()
                            ? 'Playing in the room'
                            : 'Ready to play'}
                        </small>
                      </span>
                      <Show
                        when={isCurrent()}
                        fallback={
                          <Show when={song.lyrics}>
                            <button
                              class="setlist-play"
                              type="button"
                              aria-label="Make current"
                              onClick={() => room.selectSong(song.shareId)}
                            >
                              <svg viewBox="0 0 18 18" aria-hidden="true">
                                <path d="m6.5 4.5 7 4.5-7 4.5z" />
                              </svg>
                              Play
                            </button>
                          </Show>
                        }
                      >
                        <span class="setlist-current">
                          <span aria-hidden="true" />
                          Now playing
                        </span>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ol>
            <button
              id="close-room"
              class="room-close"
              type="button"
              disabled={room.closing()}
              onClick={() => {
                if (!room.authenticated())
                  setRoomError(
                    'The room was removed from this device. Its public link will expire automatically.',
                  );
                room.closeRoom();
              }}
            >
              {room.closing() ? 'Closing…' : 'Close room'}
            </button>
          </aside>
        </Show>
      </main>

      <Show when={performanceOpen()}>
        <section
          ref={(element) => {
            performanceDialog = element;
          }}
          class="performance"
          id="performance"
          role="dialog"
          aria-modal="true"
          aria-labelledby="performance-title"
        >
          <h2 class="sr-only" id="performance-title">
            Your mehfil performance
          </h2>
          <button
            class="performance-close"
            id="performance-close"
            type="button"
            aria-label="Close performance"
            onClick={closePerformance}
          >
            ×
          </button>
          <div class="performance-content">
            <div
              class="performance-status"
              id="performance-status"
              role="status"
              aria-live="polite"
            >
              {generation.generating() ? generation.status() : ''}
            </div>
            <Show when={generation.checkGenerationVisible()}>
              <button
                class="performance-replay"
                id="check-generation"
                type="button"
                onClick={() => generation.checkGeneration()}
              >
                <span>Check generation</span>
              </button>
            </Show>
            <Show when={activeLyrics() && !playbackPreviewActive()}>
              <div class="peek" id="peek">
                <button
                  type="button"
                  class="peek-toggle"
                  id="peek-toggle"
                  aria-expanded={manualLyricsOpen()}
                  aria-controls="lyric-reveal"
                  onClick={() => {
                    setManualLyricsOpen(!manualLyricsOpen());
                  }}
                >
                  <strong>
                    {manualLyricsOpen() ? 'Hide lyrics' : 'Reveal lyrics'}
                  </strong>
                  <small>
                    {manualLyricsOpen()
                      ? 'Too late now.'
                      : "Wanna be surprised? Don't click me."}
                  </small>
                </button>
              </div>
            </Show>
            <Show
              when={
                activeLyrics() &&
                (manualRevealActive() || playbackPreviewActive())
              }
            >
              <div class="lyric-reveal" id="lyric-reveal">
                <span class="reveal-language" id="reveal-language">
                  {languageLabel()}
                </span>
                <Show when={sectionTimeline() || !manualRevealActive()}>
                  <span class="performance-timing" id="performance-timing">
                    {sectionTimeline()
                      ? 'Lines follow MiniMax sections · timing is approximate'
                      : 'Atmospheric reveal · timing is approximate'}
                  </span>
                </Show>
                <p class="reveal-lines" id="reveal-lines">
                  <Show
                    when={sectionTimeline()}
                    fallback={
                      <For each={lyricLines()}>
                        {(line, index) => {
                          const spokenBefore = () =>
                            lyricLines()
                              .slice(0, index())
                              .filter((candidate) => !candidate.cue).length;
                          const visible = () =>
                            manualRevealActive() ||
                            (line.cue
                              ? spokenBefore() ===
                                lyricLines().filter(
                                  (candidate) => !candidate.cue,
                                ).length
                                ? shownSpoken() >= spokenBefore()
                                : shownSpoken() > spokenBefore()
                              : shownSpoken() >= spokenBefore() + 1);
                          return (
                            <LyricLineView line={line} hidden={!visible()} />
                          );
                        }}
                      </For>
                    }
                  >
                    <Show
                      when={manualRevealActive()}
                      fallback={
                        <Show
                          when={activeSection()}
                          fallback={
                            <Show when={restLabel()}>
                              <span class="lyric-line lyric-cue">
                                {restLabel()}
                              </span>
                            </Show>
                          }
                        >
                          <TimedSectionView
                            section={activeSection()!}
                            activeLine={activeLine()}
                            holdLines={firstVocalLinesHeld()}
                          />
                        </Show>
                      }
                    >
                      <For each={lyricSheet().sections}>
                        {(section) => {
                          const current = () =>
                            activeEntry()?.sectionIndex === section.index;
                          return (
                            <span
                              class={
                                current()
                                  ? 'lyric-section lyric-section-current'
                                  : 'lyric-section'
                              }
                              aria-current={current() ? 'true' : undefined}
                            >
                              <For each={section.lines}>
                                {(line) => <LyricLineView line={line} />}
                              </For>
                            </span>
                          );
                        }}
                      </For>
                    </Show>
                  </Show>
                </p>
              </div>
            </Show>
            <Show when={player.ended()}>
              <button
                class="performance-replay"
                id="performance-replay"
                type="button"
                onClick={() => void player.replay()}
              >
                <span>Replay the mehfil</span>
              </button>
            </Show>
          </div>
        </section>
      </Show>

      <section
        class={`player-shell ${player.playing() ? 'playing' : ''}`}
        id="player-shell"
        aria-label="Song player"
      >
        <div class="record" aria-hidden="true">
          <div class="record-label">M</div>
        </div>
        <div class="track">
          <strong id="track-title">{player.title()}</strong>
          <span id="track-subtitle">{player.subtitle()}</span>
          <div class="timeline">
            <input
              id="seek"
              type="range"
              min="0"
              max="100"
              value={
                player.duration()
                  ? (player.currentTime() / player.duration()) * 100
                  : 0
              }
              aria-label="Seek"
              onInput={(event) =>
                player.seek(Number(event.currentTarget.value))
              }
              onChange={() => {
                const song = room.currentSong();
                if (song)
                  room.send({
                    type: 'playback-updated',
                    shareId: song.shareId,
                    status: player.playing() ? 'playing' : 'paused',
                    positionMs: player.currentTime() * 1000,
                  });
              }}
            />
            <span id="timecode">
              {formatTime(player.currentTime())} /{' '}
              {formatTime(player.duration())}
            </span>
          </div>
        </div>
        <button
          id="play"
          class="play"
          type="button"
          aria-label={`${player.playing() ? 'Pause' : 'Play'}${room.currentSong() ? ' for everyone' : ''}`}
          disabled={!player.ready()}
          onClick={() => void togglePlayback()}
        >
          <svg
            class="player-icon play-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M8.5 6.5v11l9-5.5-9-5.5Z" />
          </svg>
          <svg
            class="player-icon pause-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M8 7v10M16 7v10" />
          </svg>
        </button>
        <button
          id="view-performance"
          class="player-action performance-entry"
          type="button"
          aria-label="View performance"
          hidden={!performanceAvailable() || performanceOpen()}
          onClick={(event) => openPerformance(event.currentTarget)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 12s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" />
            <circle cx="12" cy="12" r="2.5" />
          </svg>
          <span>View</span>
        </button>
        <button
          id="share"
          class="share"
          type="button"
          aria-label="Share this song"
          disabled={!generation.shareReference()}
          onClick={() => void share()}
        >
          <svg class="player-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 8.5 12 5l3 3.5M12 5v10M7 11.5H5.5A1.5 1.5 0 0 0 4 13v4.5A1.5 1.5 0 0 0 5.5 19h13a1.5 1.5 0 0 0 1.5-1.5V13a1.5 1.5 0 0 0-1.5-1.5H17" />
          </svg>
          <span>{shareLabel()}</span>
        </button>
        <a
          id="download"
          class="download"
          href={player.source() || '#'}
          download="mehfil-song.mp3"
          aria-disabled={!player.ready()}
          aria-label="Save this song"
        >
          <svg
            class="player-icon download-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M12 5v10M8.5 11.5 12 15l3.5-3.5M5 19h14" />
          </svg>
          <span>Save</span>
        </a>
        <audio
          id="audio"
          ref={(element) => player.bindAudio(element)}
          preload="metadata"
        />
      </section>

      <Show when={diagnostics.available()}>
        <button
          id="media-diagnostics-open"
          class="media-diagnostics-open"
          type="button"
          onClick={() => diagnostics.open()}
        >
          Media diagnostics
        </button>
      </Show>
      <Show when={diagnostics.visible()}>
        <section
          id="media-diagnostics"
          class="media-diagnostics"
          role="dialog"
          aria-modal="true"
          aria-labelledby="media-diagnostics-title"
        >
          <div class="media-diagnostics-sheet">
            <p class="media-diagnostics-kicker">
              Diagnostic preview · current failure only
            </p>
            <h2 id="media-diagnostics-title">Playback stopped for evidence</h2>
            <p
              id="media-diagnostics-headline"
              class="media-diagnostics-headline"
            >
              {diagnostics.headline()}
            </p>
            <p class="media-diagnostics-help">
              Copy this sanitized report and send it back. Tokens, lyrics,
              request bodies, signed URL paths, and query strings are excluded.
            </p>
            <div class="media-diagnostics-actions">
              <button type="button" onClick={() => void player.play()}>
                Retry
              </button>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard.writeText(diagnostics.report())
                }
              >
                Copy report
              </button>
              <button type="button" onClick={() => diagnostics.clear()}>
                Clear log
              </button>
              <button type="button" onClick={() => diagnostics.close()}>
                Continue testing
              </button>
            </div>
            <pre id="media-diagnostics-output" tabIndex={0}>
              {diagnostics.report()}
            </pre>
          </div>
        </section>
      </Show>
    </>
  );
}
