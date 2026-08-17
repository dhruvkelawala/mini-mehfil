import { For, Show } from 'solid-js';

import type { ListenerSnapshot } from '../listener-room-controller.ts';

export function RoomActivity(props: { snapshot: ListenerSnapshot }) {
  const active = () =>
    props.snapshot.queue.filter(
      (item) => !['declined', 'ready'].includes(item.status),
    );
  return (
    <details class="activity">
      <summary>
        <span>Room activity</span>
        <small>
          {active().length ? `${active().length} waiting` : 'Queue'} ·{' '}
          {props.snapshot.setlist.length
            ? `${props.snapshot.setlist.length} played`
            : 'setlist'}
        </small>
      </summary>
      <div class="room-shelves">
        <section class="shelf">
          <h2>Request queue</h2>
          <ol>
            <For each={props.snapshot.queue}>
              {(item) => (
                <li>
                  {item.mine ? 'Your request' : 'A request'} — {item.status}
                </li>
              )}
            </For>
          </ol>
          <Show when={props.snapshot.currentRecording}>
            {(recording) => (
              <p class="recording">
                {props.snapshot.queue.find(
                  (item) => item.id === recording().requestId,
                )?.mine
                  ? 'The band is recording yours'
                  : 'The band is recording'}
              </p>
            )}
          </Show>
        </section>
        <section class="shelf">
          <h2>Setlist</h2>
          <ol>
            <For each={props.snapshot.setlist}>
              {(song) => (
                <li>
                  <a href={`/s/${song.shareId}`}>{song.title}</a>
                </li>
              )}
            </For>
          </ol>
        </section>
      </div>
    </details>
  );
}
