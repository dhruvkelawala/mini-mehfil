import { For, Show } from 'solid-js';

import type { ListenerSnapshot } from '../listener-room-controller.ts';

const queueStatus = (status: string) => {
  switch (status) {
    case 'pending':
      return 'Waiting for host';
    case 'accepted':
      return 'Accepted';
    case 'queued':
      return 'Up next';
    case 'failed':
      return 'Needs another take';
    case 'declined':
      return 'Not selected by host';
    default:
      return status;
  }
};

export function RoomActivity(props: { snapshot: ListenerSnapshot }) {
  const active = () =>
    props.snapshot.queue.filter(
      (item) => !['declined', 'ready'].includes(item.status),
    );
  const currentRecording = () =>
    active().find(
      (item) => item.id === props.snapshot.currentRecording?.requestId,
    );
  const waitingOnHost = () =>
    active().filter(
      (item) =>
        item.id !== props.snapshot.currentRecording?.requestId &&
        !props.snapshot.recordingQueue.includes(item.id),
    );
  const upNext = () => {
    const byId = new Map(active().map((item) => [item.id, item]));
    return props.snapshot.recordingQueue
      .filter(
        (requestId) => requestId !== props.snapshot.currentRecording?.requestId,
      )
      .map((requestId) => byId.get(requestId))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  };
  const declined = () =>
    props.snapshot.queue.filter((item) => item.status === 'declined');

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
        <section class="shelf request-shelf" aria-labelledby="requests-title">
          <h2 id="requests-title">Requests</h2>
          <div class="listener-request-workflow" aria-live="polite">
            <Show when={currentRecording()}>
              {(item) => (
                <section
                  class="listener-recording-now"
                  aria-label="Recording now"
                >
                  <div class="listener-section-heading">
                    <h3>
                      <span
                        class="listener-recording-pulse"
                        aria-hidden="true"
                      />
                      Recording now
                    </h3>
                    <span>In progress</span>
                  </div>
                  <p class="listener-request-copy">
                    <strong>
                      {item().mine ? 'Your request' : 'Listener request'}
                    </strong>
                    <small>The band is recording</small>
                  </p>
                </section>
              )}
            </Show>
            <Show when={upNext().length > 0}>
              <section class="listener-up-next" aria-label="Up next">
                <div class="listener-section-heading">
                  <h3>Up next</h3>
                  <span>
                    {upNext().length}{' '}
                    {upNext().length === 1 ? 'request' : 'requests'}
                  </span>
                </div>
                <ol>
                  <For each={upNext()}>
                    {(item, index) => (
                      <li>
                        <span
                          class="listener-request-position"
                          aria-hidden="true"
                        >
                          {index() + 1}
                        </span>
                        <span class="listener-request-copy">
                          <strong>
                            {item.mine ? 'Your request' : 'Listener request'}
                          </strong>
                          <small>{queueStatus(item.status)}</small>
                        </span>
                      </li>
                    )}
                  </For>
                </ol>
              </section>
            </Show>
            <Show when={waitingOnHost().length > 0}>
              <section class="listener-waiting" aria-label="Waiting on host">
                <div class="listener-section-heading">
                  <h3>Waiting on host</h3>
                  <span>
                    {waitingOnHost().length}{' '}
                    {waitingOnHost().length === 1 ? 'request' : 'requests'}
                  </span>
                </div>
                <ol>
                  <For each={waitingOnHost()}>
                    {(item, index) => (
                      <li>
                        <span
                          class="listener-request-position"
                          aria-hidden="true"
                        >
                          {index() + 1}
                        </span>
                        <span class="listener-request-copy">
                          <strong>
                            {item.mine ? 'Your request' : 'Listener request'}
                          </strong>
                          <small>{queueStatus(item.status)}</small>
                        </span>
                      </li>
                    )}
                  </For>
                </ol>
              </section>
            </Show>
            <Show when={declined().length > 0}>
              <section class="listener-declined" aria-label="Not selected">
                <div class="listener-section-heading">
                  <h3>Not selected</h3>
                  <span>
                    {declined().length}{' '}
                    {declined().length === 1 ? 'request' : 'requests'}
                  </span>
                </div>
                <ol>
                  <For each={declined()}>
                    {(item, index) => (
                      <li>
                        <span
                          class="listener-request-position"
                          aria-hidden="true"
                        >
                          {index() + 1}
                        </span>
                        <span class="listener-request-copy">
                          <strong>
                            {item.mine ? 'Your request' : 'Listener request'}
                          </strong>
                          <small>{queueStatus(item.status)}</small>
                        </span>
                      </li>
                    )}
                  </For>
                </ol>
              </section>
            </Show>
            <Show when={active().length === 0}>
              <Show when={declined().length === 0}>
                <p class="listener-queue-empty">No requests waiting yet.</p>
              </Show>
            </Show>
          </div>
        </section>
        <section class="shelf setlist-shelf">
          <div class="listener-section-heading">
            <h2>Setlist</h2>
            <Show when={props.snapshot.setlist.length > 0}>
              <span>
                {props.snapshot.setlist.length}{' '}
                {props.snapshot.setlist.length === 1 ? 'song' : 'songs'}
              </span>
            </Show>
          </div>
          <ol class="listener-setlist">
            <For each={props.snapshot.setlist}>
              {(song, index) => (
                <li>
                  <span class="listener-request-position" aria-hidden="true">
                    {index() + 1}
                  </span>
                  <span class="listener-request-copy">
                    <a href={`/s/${song.shareId}`}>{song.title}</a>
                    <small>Ready to play</small>
                  </span>
                </li>
              )}
            </For>
          </ol>
          <Show when={props.snapshot.setlist.length === 0}>
            <p class="listener-queue-empty">
              Songs will appear here after recording.
            </p>
          </Show>
        </section>
      </div>
    </details>
  );
}
