import { createMemo, Show, For, untrack } from 'solid-js';

import { activePacedLine, buildLinePacing } from '../../lyrics/line-pacing.ts';
import {
  activeTimelineEntry,
  buildSectionTimeline,
  parseLyricSheet,
} from '../../lyrics/lyric-sync.ts';
import { COURTYARD_SCENE } from '../../worker/courtyard.ts';
import { TimedSectionView } from '../lyrics/timed-lyrics.tsx';
import { RoomActivity } from './components/RoomActivity.tsx';
import {
  createListenerRoomController,
  type ListenerRoomController,
} from './listener-room-controller.ts';

const formatTime = (seconds: number) =>
  Number.isFinite(seconds)
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
    : '0:00';

const languages = [
  'English',
  'auto',
  'Gujarati',
  'Hindi',
  'Punjabi',
  'Tamil',
  'Bengali',
  'Marathi',
  'Urdu',
  'Spanish',
  'French',
  'Arabic',
  'Japanese',
  'Korean',
];

export function App(props: {
  roomId: string;
  controller?: ListenerRoomController;
}) {
  const controller = untrack(
    () =>
      props.controller ??
      createListenerRoomController({ roomId: props.roomId }),
  );
  const lyricSheet = createMemo(() =>
    parseLyricSheet(controller.snapshot()?.currentSong?.lyrics),
  );
  const sectionTimeline = createMemo(() =>
    buildSectionTimeline(lyricSheet().sections, controller.timing()),
  );
  const activeEntry = createMemo(() =>
    activeTimelineEntry(sectionTimeline(), controller.currentTime()),
  );
  const activeSection = createMemo(() => {
    const index = activeEntry()?.sectionIndex;
    return typeof index === 'number'
      ? lyricSheet().sections.find((section) => section.index === index)
      : undefined;
  });
  const linePacing = createMemo(() =>
    buildLinePacing(lyricSheet().sections, sectionTimeline(), null),
  );
  const activeLine = createMemo(() =>
    activePacedLine(linePacing(), controller.currentTime()),
  );
  const untimedLine = createMemo(() => {
    const spoken = lyricSheet().lines.filter((line) => !line.cue);
    if (!spoken.length) return null;
    const duration = controller.duration();
    const progress = duration
      ? Math.min(controller.currentTime() / (duration * 0.9), 1)
      : 0;
    return (
      spoken[
        Math.min(Math.floor(progress * spoken.length), spoken.length - 1)
      ] ?? null
    );
  });
  const untimedCue = createMemo(() => {
    const line = untimedLine();
    if (!line) return '';
    return (
      lyricSheet()
        .sections.find((section) => section.index === line.sectionIndex)
        ?.lines.find((candidate) => candidate.cue)?.primary ??
      line.tag ??
      ''
    );
  });
  const playbackProgress = createMemo(() => {
    const duration = controller.duration();
    if (!duration) return 0;
    return Math.min(controller.currentTime() / duration, 1);
  });
  let nameInput: HTMLInputElement | undefined;
  let requestForm: HTMLFormElement | undefined;

  const join = (event: SubmitEvent) => {
    event.preventDefault();
    controller.connect(nameInput?.value ?? '');
  };
  const requestSong = (event: SubmitEvent) => {
    event.preventDefault();
    if (!requestForm) return;
    const data = new FormData(requestForm);
    const field = (name: string, fallback = '') => {
      const value = data.get(name);
      return typeof value === 'string' ? value : fallback;
    };
    controller.submitRequest({
      idea: field('idea'),
      vibe: field('vibe'),
      language: field('language', 'auto'),
    });
    requestForm.reset();
  };

  return (
    <>
      {/* The courtyard is a repository-owned static SVG constant, never user input. */}
      {/* eslint-disable-next-line solid/no-innerhtml */}
      <div class="scene" aria-hidden="true" innerHTML={COURTYARD_SCENE} />
      <div class="grain" aria-hidden="true" />
      <header class="topbar">
        <div class="topbar-room">
          Room <strong>{props.roomId}</strong>
        </div>
        <div class="live">
          <i />
          <span>music-3.0</span>
        </div>
        <div class="listener-label">Listener</div>
      </header>
      <main class="room-layout">
        <section
          class={`identity ${controller.snapshot()?.currentSong ? 'has-song' : ''}`}
          aria-labelledby="brand-title"
        >
          <h1 id="brand-title" aria-label="Mini Mehfil">
            <span class="mini" aria-hidden="true">
              Mini
            </span>
            महफ़िल
          </h1>
          <p class="tagline">
            A private song room. Request the next tune, then listen together.
          </p>
          <p class="status" aria-live="polite">
            {controller.status()}
          </p>
          <Show when={controller.snapshot()?.currentSong}>
            {(song) => (
              <section class="lyric-stage">
                <h2>{song().title}</h2>
                <Show
                  when={activeSection()}
                  fallback={
                    <Show when={untimedLine()}>
                      {(line) => (
                        <>
                          <p class="lyric-cue">{untimedCue()}</p>
                          <p class="lyric-primary">{line().primary}</p>
                          <p class="lyric-secondary">{line().secondary}</p>
                        </>
                      )}
                    </Show>
                  }
                >
                  {(section) => (
                    <TimedSectionView
                      section={section()}
                      activeLine={activeLine()}
                    />
                  )}
                </Show>
              </section>
            )}
          </Show>
        </section>

        <Show when={!controller.joined()}>
          <form class="composer" onSubmit={join}>
            <div class="composer-head">
              <h2>Join the mehfil</h2>
              <span class="room-chip">Room {props.roomId}</span>
            </div>
            <p class="composer-copy">
              No account or key needed. Add a name so the host knows who joined.
            </p>
            <label class="field">
              <span>
                Your name <em>optional</em>
              </span>
              <input
                ref={(element) => {
                  nameInput = element;
                }}
                maxlength="40"
                autocomplete="nickname"
                placeholder="What should we call you?"
              />
            </label>
            <button class="generate" type="submit">
              <span>Join the mehfil</span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12h13M14 7l5 5-5 5" />
              </svg>
            </button>
            <small class="join-note">
              Your first tap also prepares this browser for shared audio.
            </small>
          </form>
        </Show>

        <Show when={controller.snapshot()}>
          {(snapshot) => (
            <section class="room">
              <details class="room-menu">
                <summary>
                  <span>Request a song</span>
                  <small>
                    {snapshot().listenerCount} listener
                    {snapshot().listenerCount === 1 ? '' : 's'} ·{' '}
                    {snapshot().hostPresent ? 'Host present' : 'Host away'}
                  </small>
                </summary>
                <div class="room-menu-body">
                  <form
                    ref={(element) => {
                      requestForm = element;
                    }}
                    onSubmit={requestSong}
                  >
                    <label class="field">
                      <span>What's the song about?</span>
                      <textarea
                        name="idea"
                        maxlength="200"
                        required
                        placeholder="A late-night drive home, monsoon chai…"
                      />
                    </label>
                    <div class="field-row">
                      <label class="field">
                        <span>
                          Vibe <em>optional</em>
                        </span>
                        <input
                          name="vibe"
                          maxlength="120"
                          placeholder="warm, acoustic"
                        />
                      </label>
                      <label class="field">
                        <span>Language</span>
                        <select name="language">
                          <For each={languages}>
                            {(language) => (
                              <option
                                value={language}
                                selected={language === 'auto'}
                              >
                                {language === 'auto' ? 'Auto-detect' : language}
                              </option>
                            )}
                          </For>
                        </select>
                      </label>
                    </div>
                    <button class="generate">
                      <span>Send request</span>
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 12h13M14 7l5 5-5 5" />
                      </svg>
                    </button>
                  </form>
                  <RoomActivity snapshot={snapshot()} />
                </div>
              </details>
              <section
                class={`player-shell ${controller.playing() ? 'is-playing' : ''}`}
                aria-label="Host-controlled song player"
              >
                <div class="record" aria-hidden="true">
                  <span class="record-mark">M</span>
                </div>
                <div class="player-track">
                  <h2>
                    {snapshot().currentSong?.title ??
                      'Waiting for the first song'}
                  </h2>
                  <p>
                    {snapshot().currentSong?.language ??
                      'The host controls playback'}
                  </p>
                  <p>{controller.playbackLabel()}</p>
                  <Show when={snapshot().currentSong}>
                    <div class="player-progress">
                      <div
                        class="player-progress-bar"
                        role="progressbar"
                        aria-label="Song progress"
                        aria-valuemin="0"
                        aria-valuemax={controller.duration()}
                        aria-valuenow={controller.currentTime()}
                      >
                        <span
                          style={{ width: `${playbackProgress() * 100}%` }}
                        />
                      </div>
                      <time>
                        {formatTime(controller.currentTime())} /{' '}
                        {formatTime(controller.duration())}
                      </time>
                    </div>
                  </Show>
                </div>
                <audio
                  ref={(element) => controller.bindAudio(element)}
                  preload="metadata"
                />
                <Show when={snapshot().currentSong}>
                  <span class="player-state" aria-hidden="true">
                    <Show
                      when={controller.playing()}
                      fallback={
                        <svg viewBox="0 0 18 18">
                          <path d="m6.5 4.5 7 4.5-7 4.5z" />
                        </svg>
                      }
                    >
                      <svg viewBox="0 0 18 18">
                        <path d="M6.5 5v8M11.5 5v8" />
                      </svg>
                    </Show>
                  </span>
                </Show>
                <Show when={controller.audioBlocked()}>
                  <button
                    class="enable-audio"
                    type="button"
                    onClick={() => void controller.enableAudio()}
                  >
                    Enable sound
                  </button>
                  <p class="play-error" role="alert">
                    Your browser blocked shared audio. Enable sound once to join
                    the music.
                  </p>
                </Show>
              </section>
            </section>
          )}
        </Show>
      </main>
    </>
  );
}
