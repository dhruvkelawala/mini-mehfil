import { createMemo, Show, For, untrack } from 'solid-js';

import { COURTYARD_SCENE } from '../../worker/courtyard.ts';
import { RoomActivity } from './components/RoomActivity.tsx';
import {
  createListenerRoomController,
  type ListenerRoomController,
} from './listener-room-controller.ts';

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

function lyricLines(controller: ListenerRoomController) {
  const lines = createMemo(() => {
    const sheet = controller.snapshot()?.currentSong?.lyrics;
    if (!sheet) return { primary: '', secondary: '' };
    const native = sheet.lyricsNative
      .split('\n')
      .find((line) => line.trim() && !/^\[.+\]$/.test(line));
    const roman = sheet.lyricsRoman
      .split('\n')
      .find((line) => line.trim() && !/^\[.+\]$/.test(line));
    return sheet.isLatinScript
      ? { primary: roman ?? native ?? '', secondary: '' }
      : { primary: native ?? roman ?? '', secondary: roman ?? '' };
  });
  return lines;
}

export function App(props: {
  roomId: string;
  controller?: ListenerRoomController;
}) {
  const controller = untrack(
    () =>
      props.controller ??
      createListenerRoomController({ roomId: props.roomId }),
  );
  const lyrics = lyricLines(controller);
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
                <p class="lyric-primary">{lyrics().primary}</p>
                <p class="lyric-secondary">{lyrics().secondary}</p>
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
              <span aria-hidden="true">→</span>
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
                              <option value={language}>
                                {language === 'auto' ? 'Auto-detect' : language}
                              </option>
                            )}
                          </For>
                        </select>
                      </label>
                    </div>
                    <button class="generate">
                      <span>Send request</span>
                      <span aria-hidden="true">→</span>
                    </button>
                  </form>
                  <RoomActivity snapshot={snapshot()} />
                </div>
              </details>
              <section
                class={`player-shell ${snapshot().currentSong?.playback.status === 'playing' ? 'is-playing' : ''}`}
                aria-label="Host-controlled song player"
              >
                <div class="record" aria-hidden="true" />
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
                </div>
                <audio
                  ref={(element) => controller.bindAudio(element)}
                  preload="metadata"
                />
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
