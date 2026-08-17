import { createSignal, For, Show } from 'solid-js';

import { COURTYARD_SCENE } from '../../worker/courtyard.ts';
import { createGenerationController } from './generation-controller.ts';
import { createHostRoomController } from './host-room-controller.ts';
import { createMediaDiagnostics } from './media-diagnostics.ts';
import { createPlayerController } from './player-controller.ts';

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

export function App() {
  const diagnostics = createMediaDiagnostics();
  const room = createHostRoomController();
  const player = createPlayerController(diagnostics);
  const generation = createGenerationController({
    player,
    onSongReady: (jobId, lyrics) => room.publishSong(jobId, lyrics),
  });
  const [roomError, setRoomError] = createSignal('');
  let form: HTMLFormElement | undefined;

  const generate = (event: SubmitEvent) => {
    event.preventDefault();
    if (!form) return;
    const data = new FormData(form);
    const field = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };
    void generation.generate({
      token: field('token'),
      idea: field('idea'),
      vibe: field('vibe'),
      language: field('language') || 'auto',
    });
  };

  const openRoom = async () => {
    setRoomError('');
    try {
      await room.open();
    } catch (error) {
      setRoomError(
        error instanceof Error
          ? error.message
          : 'The room could not be opened.',
      );
    }
  };

  return (
    <>
      {/* Repository-owned static SVG; never contains user input. */}
      {/* eslint-disable-next-line solid/no-innerhtml */}
      <div class="scene" aria-hidden="true" innerHTML={COURTYARD_SCENE} />
      <div class="grain" aria-hidden="true" />
      <header class="topbar">
        <span id="clock">music-3.0</span>
        <button type="button" class="room-open" onClick={() => void openRoom()}>
          Open this mehfil to friends
        </button>
        <a href="https://platform.minimax.io/docs/api-reference/music-generation">
          API docs ↗
        </a>
      </header>
      <main class="layout">
        <section class="identity" aria-label="Mini Mehfil">
          <h1 aria-label="Mini Mehfil">
            <span>Mini</span>महफ़िल
          </h1>
          <p>
            A private song room. Write the words, set the mood, let them sing.
          </p>
          <Show when={generation.lyrics()}>
            {(sheet) => (
              <div class="lyrics">
                <h2>{sheet().title}</h2>
                <p>{sheet().lyricsNative}</p>
                <p>{sheet().lyricsRoman}</p>
              </div>
            )}
          </Show>
        </section>
        <form
          class="composer"
          ref={(element) => {
            form = element;
          }}
          onSubmit={generate}
        >
          <div class="composer-head">
            <h2>Make a song</h2>
            <span>≈ $0.15</span>
          </div>
          <label class="field">
            <span>MiniMax token</span>
            <input
              name="token"
              type="password"
              autocomplete="off"
              placeholder="sk-cp-••••••••"
              required
            />
            <small>Used for this request only. Never saved.</small>
          </label>
          <label class="field">
            <span>What's the song about?</span>
            <textarea
              name="idea"
              required
              maxlength="400"
              placeholder="Aloopuri Khavsa"
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
              <input name="vibe" placeholder="hip hop, upbeat" />
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
          <p class="notice" role="status">
            {generation.status()}
          </p>
          <button
            class="generate"
            disabled={generation.generating()}
            type="submit"
          >
            <span>
              {generation.generating()
                ? 'Making your song…'
                : 'Start the mehfil'}
            </span>
            <span aria-hidden="true">→</span>
          </button>
          <p class="cost">
            Lyrics cost about a tenth of a cent. The song costs ≈ $0.15.
          </p>
        </form>
      </main>

      <section
        class={`player ${player.playing() ? 'is-playing' : ''}`}
        aria-label="Song player"
      >
        <div class="record" aria-hidden="true" />
        <div>
          <strong>{player.title()}</strong>
          <p>{player.subtitle()}</p>
        </div>
        <button
          type="button"
          disabled={!player.ready()}
          onClick={() => void player.toggle()}
        >
          {player.playing() ? 'Pause' : 'Play'}
        </button>
        <audio
          ref={(element) => player.bindAudio(element)}
          preload="metadata"
        />
      </section>

      <Show when={room.details()}>
        {(details) => (
          <aside class="room-panel" aria-label="Live room">
            <strong>Room {details().roomId}</strong>
            <span>{room.status()}</span>
            <a href={details().joinUrl}>Listener link</a>
            <button type="button" onClick={() => room.close()}>
              Close room
            </button>
          </aside>
        )}
      </Show>
      <Show when={roomError()}>
        <p class="toast" role="alert">
          {roomError()}
        </p>
      </Show>

      <Show when={diagnostics.visible()}>
        <button class="diagnostics-open" type="button">
          Media diagnostics
        </button>
        <section
          class="diagnostics"
          role="dialog"
          aria-modal="true"
          aria-label="Media diagnostics"
        >
          <h2>{diagnostics.headline()}</h2>
          <p>Copy this sanitized report and send it back.</p>
          <pre>{diagnostics.report()}</pre>
          <button type="button" onClick={() => diagnostics.close()}>
            Continue testing
          </button>
        </section>
      </Show>
    </>
  );
}
