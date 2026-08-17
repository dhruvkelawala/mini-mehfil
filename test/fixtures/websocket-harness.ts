import type { Page } from '@playwright/test';

export async function installWebSocketHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
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
            state: {
              version: 1,
              roomId: 'ABCDEFGH',
              hostPresent: true,
              listenerCount: 0,
              participants: [],
              queue: [],
              currentRecording: null,
              currentSong: null,
              setlist: [],
            },
          });
        }
        if (message.type === 'join') {
          this.serverMessage({
            type: 'resume-credential',
            credential: 'resume-fixture',
          });
          this.serverMessage({
            type: 'snapshot',
            state: {
              version: 1,
              roomId: 'ABCDEFGH',
              hostPresent: true,
              listenerCount: 1,
              queue: [],
              currentRecording: null,
              currentSong: {
                shareId: 'abcdefghijklmnop',
                title: 'Monsoon Song',
                language: 'Hindi',
                startedAt: Date.now(),
                lyrics: {
                  language: 'Hindi',
                  nativeScriptName: 'Devanagari',
                  isLatinScript: false,
                  lyricsNative: 'बारिश की रात',
                  lyricsRoman: 'Baarish ki raat',
                },
                playback: {
                  status: 'paused',
                  positionMs: 0,
                  changedAt: Date.now(),
                },
              },
              setlist: [],
            },
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
          Object.assign(new Event('message'), { data: JSON.stringify(value) }),
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
  });
}
