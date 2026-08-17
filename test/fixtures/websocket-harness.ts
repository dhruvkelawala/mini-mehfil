import type { Page } from '@playwright/test';

import type { RoomState } from '../../src/room/protocol.ts';
import { createRoomState, projectRoomState } from '../../src/room/state.ts';

const openedAt = 1_700_000_000_000;
const hostState = createRoomState({
  roomId: 'ABCDEFGH',
  openedAt,
  expiresAt: openedAt + 60_000,
});
hostState.hostPresent = true;

const listenerState: RoomState = structuredClone(hostState);
listenerState.participants.push({
  id: 'listener-fixture',
  name: 'Listener',
  connected: true,
  joinedAt: openedAt,
});
listenerState.currentSong = {
  requestId: null,
  shareId: 'abcdefghijklmnop',
  title: 'Monsoon Song',
  language: 'Hindi',
  startedAt: openedAt,
  lyrics: {
    title: 'Monsoon Song',
    language: 'Hindi',
    nativeScriptName: 'Devanagari',
    isLatinScript: false,
    lyricsNative: 'बारिश की रात',
    lyricsRoman: 'Baarish ki raat',
  },
  playback: { status: 'paused', positionMs: 0, changedAt: openedAt },
};

export function projectHostFixture(state: RoomState): unknown {
  return projectRoomState(state, { role: 'host', participantId: 'host' });
}

export async function installWebSocketHarness(page: Page): Promise<void> {
  await page.addInitScript(
    ({ hostSnapshot, listenerSnapshot }) => {
      type Handler = (event: Event & { data?: string; code?: number }) => void;
      class FixtureWebSocket {
        static readonly OPEN = 1;
        readonly OPEN = 1;
        readyState = 0;
        sent: string[] = [];
        readonly url: string;
        private listeners = new Map<string, Handler[]>();

        constructor(url: string) {
          this.url = url;
          const fixtureWindow = window as typeof window & {
            __mehfilSockets?: FixtureWebSocket[];
          };
          (fixtureWindow.__mehfilSockets ??= []).push(this);
          queueMicrotask(() => {
            this.readyState = 1;
            this.emit('open', new Event('open'));
          });
        }

        addEventListener(type: string, handler: Handler): void {
          const handlers = this.listeners.get(type) ?? [];
          handlers.push(handler);
          this.listeners.set(type, handlers);
        }

        send(value: string): void {
          this.sent.push(value);
          const message = JSON.parse(value) as { type?: string };
          if (message.type === 'auth-host') {
            this.serverMessage({
              type: 'snapshot',
              state: hostSnapshot,
            });
          }
          if (message.type === 'join') {
            this.serverMessage({
              type: 'resume-credential',
              credential: 'resume-fixture',
            });
            this.serverMessage({
              type: 'snapshot',
              state: listenerSnapshot,
            });
          }
        }

        close(code = 1000): void {
          this.readyState = 3;
          this.emit('close', Object.assign(new Event('close'), { code }));
        }

        serverMessage(value: unknown): void {
          this.emit(
            'message',
            Object.assign(new Event('message'), {
              data: JSON.stringify(value),
            }),
          );
        }

        private emit(
          type: string,
          event: Event & { data?: string; code?: number },
        ) {
          for (const handler of this.listeners.get(type) ?? []) handler(event);
        }
      }

      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        value: FixtureWebSocket,
      });
    },
    {
      hostSnapshot: projectRoomState(hostState, {
        role: 'host',
        participantId: 'host',
      }),
      listenerSnapshot: projectRoomState(listenerState, {
        role: 'listener',
        participantId: 'listener-fixture',
      }),
    },
  );
}
