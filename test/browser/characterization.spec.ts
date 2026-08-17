import { expect, test } from '@playwright/test';

import type { RoomState } from '../../src/room/protocol.ts';
import {
  installWebSocketHarness,
  projectHostFixture,
} from '../fixtures/websocket-harness.ts';

async function fillSong(page: Parameters<typeof installWebSocketHarness>[0]) {
  await page.getByLabel(/MiniMax token/).fill('sk-fixture-secret-token');
  await page.getByLabel(/What's the song about\?/).fill('Monsoon Song');
}

test('host writes, records, and exposes the finished player', async ({
  page,
}) => {
  await page.goto('/');
  await fillSong(page);
  await page.getByRole('button', { name: 'Start the mehfil' }).click();
  await expect(page.getByText('Your recording is ready.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled();
});

test('a lost paid response is recovered without a second paid POST', async ({
  page,
}) => {
  let generatePosts = 0;
  await page.route('**/api/generate', async (route) => {
    generatePosts += 1;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'pending' }),
    });
  });
  await page.route('**/api/generation-status?*', async (route) => {
    const jobId = new URL(route.request().url()).searchParams.get('id');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        jobId,
        status: 'complete',
        data: { audio: '49443304000000000000' },
        share_ref: jobId,
      }),
    });
  });
  await page.goto('/');
  await fillSong(page);
  await page.getByRole('button', { name: 'Start the mehfil' }).click();
  await expect(page.getByText('Your recording is ready.')).toBeVisible();
  expect(generatePosts).toBe(1);
});

test('playback rejection exposes diagnostics and a recovery action', async ({
  page,
}) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () =>
      Promise.reject(new DOMException('autoplay blocked', 'NotAllowedError'));
  });
  await page.goto('/?mediaDebug=1');
  await fillSong(page);
  await page.getByRole('button', { name: 'Start the mehfil' }).click();
  await expect(
    page.getByRole('button', { name: 'Media diagnostics' }),
  ).toBeVisible();
});

test('a host authenticates before receiving room state', async ({ page }) => {
  await installWebSocketHarness(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open this mehfil to friends' })
    .click();
  await expect(page.getByText('connected')).toBeVisible();
  const firstFrame = await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ sent: string[] }>;
    };
    return fixtureWindow.__mehfilSockets[0]?.sent[0];
  });
  expect(JSON.parse(firstFrame ?? '{}')).toEqual({
    type: 'auth-host',
    secret: 'A'.repeat(43),
  });
});

test('the missing-token warning clears after a recording is queued', async ({
  page,
}) => {
  await installWebSocketHarness(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open this mehfil to friends' })
    .click();
  await expect(page.getByText('connected')).toBeVisible();
  await page.evaluate(
    (snapshot) => {
      const fixtureWindow = window as typeof window & {
        __mehfilSockets: Array<{
          sent: string[];
          serverMessage(value: unknown): void;
        }>;
      };
      fixtureWindow.__mehfilSockets[0]?.serverMessage({
        type: 'snapshot',
        state: snapshot,
      });
    },
    projectHostFixture({
      version: 1,
      roomId: 'ABCDEFGH',
      openedAt: 1,
      expiresAt: Date.now() + 60_000,
      expiredAt: null,
      hostPresent: true,
      participants: [
        { id: 'listener-1', name: 'Listener', connected: true, joinedAt: 1 },
      ],
      kickedParticipantIds: [],
      queue: [
        {
          id: 'request-a',
          participantId: 'listener-1',
          idea: 'Request A',
          vibe: '',
          language: 'Hindi',
          status: 'accepted',
          submittedAt: 2,
        },
      ],
      recordingQueue: [],
      currentRecording: null,
      currentSong: null,
      setlist: [],
    }),
  );

  const recordButton = page
    .locator('#host-queue')
    .getByRole('button', { name: 'Record' });
  await recordButton.click();
  await expect(
    page.getByText('Paste your MiniMax token before queueing a recording.'),
  ).toBeVisible();

  await page.getByLabel(/MiniMax token/).fill('sk-fixture-secret-token');
  await recordButton.click();
  await expect(
    page.getByText('Paste your MiniMax token before queueing a recording.'),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const fixtureWindow = window as typeof window & {
          __mehfilSockets: Array<{ sent: string[] }>;
        };
        return (fixtureWindow.__mehfilSockets[0]?.sent ?? []).some((frame) =>
          frame.includes('recording-enqueued'),
        );
      }),
    )
    .toBe(true);
});

test('a refreshed host does not claim queued paid work before its token is present', async ({
  page,
}) => {
  await installWebSocketHarness(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open this mehfil to friends' })
    .click();
  await expect(page.getByText('connected')).toBeVisible();
  await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ serverMessage(value: unknown): void }>;
    };
    fixtureWindow.__mehfilSockets[0]?.serverMessage({
      type: 'snapshot',
      state: {
        version: 1,
        roomId: 'ABCDEFGH',
        openedAt: 1,
        expiresAt: Date.now() + 60_000,
        expiredAt: null,
        hostPresent: true,
        listenerCount: 1,
        participants: [
          {
            id: 'listener-1',
            name: 'Listener',
            connected: true,
            joinedAt: 1,
          },
        ],
        queue: [
          {
            id: 'request-b',
            participantId: 'listener-1',
            idea: 'Request B',
            vibe: '',
            language: 'Hindi',
            status: 'queued',
            submittedAt: 2,
          },
        ],
        recordingQueue: ['request-b'],
        currentRecording: null,
        currentSong: null,
        setlist: [],
      },
    });
  });
  const recordingStarts = () =>
    page.evaluate(() => {
      const fixtureWindow = window as typeof window & {
        __mehfilSockets: Array<{ sent: string[] }>;
      };
      return (fixtureWindow.__mehfilSockets[0]?.sent ?? []).filter((frame) =>
        frame.includes('recording-started'),
      ).length;
    });
  await expect.poll(recordingStarts).toBe(0);
  await page.getByLabel(/MiniMax token/).fill('sk-fixture-secret-token');
  await expect.poll(recordingStarts).toBe(1);
  await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ serverMessage(value: unknown): void }>;
    };
    fixtureWindow.__mehfilSockets[0]?.serverMessage({
      type: 'snapshot',
      state: {
        version: 1,
        roomId: 'ABCDEFGH',
        openedAt: 1,
        expiresAt: Date.now() + 60_000,
        expiredAt: null,
        hostPresent: true,
        listenerCount: 1,
        participants: [
          {
            id: 'listener-1',
            name: 'Listener',
            connected: true,
            joinedAt: 1,
          },
        ],
        queue: [
          {
            id: 'request-b',
            participantId: 'listener-1',
            idea: 'Request B',
            vibe: '',
            language: 'Hindi',
            status: 'failed',
            submittedAt: 2,
          },
        ],
        recordingQueue: [],
        currentRecording: null,
        currentSong: null,
        setlist: [],
      },
    });
  });
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('background recordings stay sequential and switch playback only when selected', async ({
  page,
  context,
}) => {
  await installWebSocketHarness(page);
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
  });
  let releaseFirst: (() => void) | undefined;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let generateCalls = 0;
  let paidInFlight = 0;
  let maxPaidInFlight = 0;
  await page.route('**/api/generate', async (route) => {
    generateCalls += 1;
    paidInFlight += 1;
    maxPaidInFlight = Math.max(maxPaidInFlight, paidInFlight);
    if (generateCalls === 1) await firstMayFinish;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: { audio: '49443304000000000000' },
        share_ref: `reference-${generateCalls}`,
      }),
    });
    paidInFlight -= 1;
  });
  await page.route('**/api/share', async (route) => {
    const body = route.request().postDataJSON() as { title?: string };
    const shareId =
      body.title === 'Request C' ? 'cccccccccccccccc' : 'bbbbbbbbbbbbbbbb';
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        url: `https://rooms.example.test/s/${shareId}`,
      }),
    });
  });

  await page.goto('/');
  await page.getByLabel(/MiniMax token/).fill('sk-fixture-secret-token');
  await page
    .getByRole('button', { name: 'Open this mehfil to friends' })
    .click();

  const listener = await context.newPage();
  await installWebSocketHarness(listener);
  await listener.addInitScript(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
  });
  await listener.goto('/r/ABCDEFGH');
  await listener.getByLabel('Your name').fill('Listener');
  await listener.getByRole('button', { name: 'Join the mehfil' }).click();

  const lyrics = (title: string, line: string) => ({
    title,
    language: 'Hindi',
    nativeScriptName: 'Devanagari',
    isLatinScript: false,
    lyricsNative: line,
    lyricsRoman: `${line} roman`,
  });
  const songA: RoomState['currentSong'] = {
    requestId: null,
    shareId: 'aaaaaaaaaaaaaaaa',
    title: 'Song A',
    language: 'Hindi',
    startedAt: 1,
    lyrics: lyrics('Song A', 'lyrics a'),
    playback: { status: 'playing', positionMs: 0, changedAt: Date.now() },
  };
  const requestB: RoomState['queue'][number] = {
    id: 'request-b',
    participantId: 'listener-1',
    idea: 'Request B',
    vibe: 'soft',
    language: 'Hindi',
    status: 'accepted',
    submittedAt: 2,
  };
  const requestC: RoomState['queue'][number] = {
    ...requestB,
    id: 'request-c',
    idea: 'Request C',
    submittedAt: 3,
  };
  const hostState = (overrides: Partial<RoomState> = {}): RoomState => ({
    version: 1,
    roomId: 'ABCDEFGH',
    openedAt: 1,
    expiresAt: Date.now() + 60_000,
    expiredAt: null,
    hostPresent: true,
    participants: [
      { id: 'listener-1', name: 'Listener', connected: true, joinedAt: 1 },
    ],
    kickedParticipantIds: [],
    queue: [requestB, requestC],
    recordingQueue: [],
    currentRecording: null,
    currentSong: songA,
    setlist: [],
    ...overrides,
  });
  const listenerState = (state: ReturnType<typeof hostState>) => ({
    ...state,
    participants: [{ name: 'Listener' }],
    listenerCount: 1,
    queue: state.queue.map((item) => ({
      id: item.id,
      status: item.status,
      mine: true,
    })),
    currentRecording: state.currentRecording
      ? {
          requestId: state.currentRecording.requestId,
          startedAt: state.currentRecording.startedAt,
        }
      : null,
    setlist: state.setlist.map((song) => ({
      shareId: song.shareId,
      title: song.title,
      language: song.language,
      startedAt: song.startedAt,
    })),
  });
  const serverMessage = async (target: typeof page, state: unknown) => {
    const snapshot =
      target === page ? projectHostFixture(state as RoomState) : state;
    await target.evaluate((nextState) => {
      const fixtureWindow = window as typeof window & {
        __mehfilSockets: Array<{ serverMessage(value: unknown): void }>;
      };
      fixtureWindow.__mehfilSockets[0]?.serverMessage({
        type: 'snapshot',
        state: nextState,
      });
    }, snapshot);
  };
  interface SentFrame {
    type: string;
    coordinatorId?: string;
  }
  const sentFrames = (target: typeof page): Promise<SentFrame[]> =>
    target.evaluate(() => {
      const fixtureWindow = window as typeof window & {
        __mehfilSockets: Array<{ sent: string[] }>;
      };
      return (fixtureWindow.__mehfilSockets[0]?.sent ?? []).flatMap((frame) => {
        const parsed: unknown = JSON.parse(frame);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('type' in parsed) ||
          typeof parsed.type !== 'string'
        ) {
          return [];
        }
        return [
          {
            type: parsed.type,
            ...('coordinatorId' in parsed &&
            typeof parsed.coordinatorId === 'string'
              ? { coordinatorId: parsed.coordinatorId }
              : {}),
          },
        ];
      });
    });

  let state = hostState();
  await serverMessage(page, state);
  await serverMessage(listener, listenerState(state));
  await page.getByRole('button', { name: 'Record' }).first().click();
  state = hostState({
    queue: [{ ...requestB, status: 'queued' }, requestC],
    recordingQueue: ['request-b'],
  });
  await serverMessage(page, state);
  await expect
    .poll(async () =>
      (await sentFrames(page)).find(
        (frame) => frame.type === 'recording-started',
      ),
    )
    .toBeTruthy();
  const startB = (await sentFrames(page)).find(
    (frame) => frame.type === 'recording-started',
  );
  if (!startB?.coordinatorId) throw new Error('Host did not claim request B');
  state = hostState({
    queue: [{ ...requestB, status: 'recording' }, requestC],
    currentRecording: {
      requestId: 'request-b',
      coordinatorId: startB.coordinatorId,
      startedAt: 4,
      lyrics: null,
    },
  });
  await serverMessage(page, state);
  await serverMessage(listener, listenerState(state));
  await expect.poll(() => generateCalls).toBe(1);
  await page.getByRole('button', { name: 'Record' }).click();
  state = hostState({
    queue: [
      { ...requestB, status: 'recording' },
      { ...requestC, status: 'queued' },
    ],
    recordingQueue: ['request-c'],
    currentRecording: {
      requestId: 'request-b',
      coordinatorId: startB.coordinatorId,
      startedAt: 4,
      lyrics: lyrics('Request B', 'lyrics b'),
    },
  });
  await serverMessage(page, state);
  await serverMessage(listener, listenerState(state));
  await expect(page.locator('#track-title')).toHaveText('Song A');
  await expect(
    listener.getByRole('heading', { name: 'Song A' }).first(),
  ).toBeVisible();
  await expect(listener.getByText('lyrics a', { exact: true })).toBeVisible();
  expect(generateCalls).toBe(1);
  expect(maxPaidInFlight).toBe(1);

  releaseFirst?.();
  await expect
    .poll(async () =>
      (await sentFrames(page)).some((frame) => frame.type === 'song-ready'),
    )
    .toBe(true);
  const readyB = {
    requestId: 'request-b',
    shareId: 'bbbbbbbbbbbbbbbb',
    title: 'Request B',
    language: 'Hindi',
    startedAt: 5,
    lyrics: lyrics('Request B', 'lyrics b'),
  };
  state = hostState({
    queue: [
      { ...requestB, status: 'ready' },
      { ...requestC, status: 'queued' },
    ],
    recordingQueue: ['request-c'],
    setlist: [readyB],
  });
  await serverMessage(page, state);
  await serverMessage(listener, listenerState(state));
  await expect(page.locator('#track-title')).toHaveText('Song A');
  await expect(
    page.getByRole('button', { name: 'Make current' }),
  ).toBeVisible();
  expect(generateCalls).toBe(1);

  await expect
    .poll(
      async () =>
        (await sentFrames(page)).filter(
          (frame) => frame.type === 'recording-started',
        ).length,
    )
    .toBe(2);
  const startC = (await sentFrames(page)).filter(
    (frame) => frame.type === 'recording-started',
  )[1];
  if (!startC?.coordinatorId) throw new Error('Host did not claim request C');
  state = hostState({
    queue: [
      { ...requestB, status: 'ready' },
      { ...requestC, status: 'recording' },
    ],
    currentRecording: {
      requestId: 'request-c',
      coordinatorId: startC.coordinatorId,
      startedAt: 6,
      lyrics: null,
    },
    setlist: [readyB],
  });
  await serverMessage(page, state);
  await expect.poll(() => generateCalls).toBe(2);
  expect(maxPaidInFlight).toBe(1);

  await page.getByRole('button', { name: 'Make current' }).click();
  state = hostState({
    queue: state.queue,
    currentRecording: state.currentRecording,
    setlist: [readyB],
    currentSong: {
      ...readyB,
      playback: { status: 'paused', positionMs: 0, changedAt: 7 },
    },
  });
  await serverMessage(page, state);
  await serverMessage(listener, listenerState(state));
  await expect(page.locator('#track-title')).toHaveText('Request B');
  await expect(page.getByText('Now playing', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Current' })).toHaveCount(0);
  await expect(
    listener.getByRole('heading', { name: 'Request B' }).first(),
  ).toBeVisible();
  await expect(listener.getByText('lyrics b', { exact: true })).toBeVisible();
});

test('a listener joins, resumes, renders synchronized lyrics, and stops on expiry', async ({
  page,
}) => {
  await installWebSocketHarness(page);
  await page.goto('/r/ABCDEFGH');
  await page.getByLabel('Your name').fill('Listener');
  await page.getByRole('button', { name: 'Join the mehfil' }).click();
  await expect(
    page.getByRole('heading', { name: 'Monsoon Song' }).first(),
  ).toBeVisible();
  await expect(page.getByText('बारिश की रात')).toBeVisible();
  await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ serverMessage(value: unknown): void }>;
    };
    fixtureWindow.__mehfilSockets[0]?.serverMessage({
      type: 'error',
      code: 'room-expired',
    });
  });
  await expect(page.getByText('This mehfil has ended.')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test('listener playback advances its progress, lyrics, and record between room updates', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const media = window as typeof window & {
      __mediaCurrentTime?: number;
      __mediaPaused?: boolean;
    };
    media.__mediaCurrentTime = 0;
    media.__mediaPaused = true;
    Object.defineProperties(HTMLMediaElement.prototype, {
      currentTime: {
        configurable: true,
        get: () => media.__mediaCurrentTime ?? 0,
        set: (value: number) => {
          media.__mediaCurrentTime = value;
        },
      },
      duration: { configurable: true, get: () => 120 },
      paused: { configurable: true, get: () => media.__mediaPaused ?? true },
      ended: { configurable: true, get: () => false },
      readyState: { configurable: true, get: () => 4 },
    });
    HTMLMediaElement.prototype.play = function () {
      media.__mediaPaused = false;
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      media.__mediaPaused = true;
      this.dispatchEvent(new Event('pause'));
    };
  });
  await installWebSocketHarness(page);
  await page.goto('/r/ABCDEFGH');
  await page.getByLabel('Your name').fill('Listener');
  await page.getByRole('button', { name: 'Join the mehfil' }).click();
  await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ serverMessage(value: unknown): void }>;
    };
    fixtureWindow.__mehfilSockets[0]?.serverMessage({
      type: 'snapshot',
      state: {
        hostPresent: true,
        listenerCount: 1,
        queue: [],
        currentRecording: null,
        currentSong: {
          shareId: 'abcdefghijklmnop',
          title: 'Four-line Song',
          language: 'Hindi',
          startedAt: 1,
          playback: {
            status: 'playing',
            positionMs: 0,
            changedAt: Date.now(),
          },
          lyrics: {
            title: 'Four-line Song',
            language: 'Hindi',
            nativeScriptName: 'Devanagari',
            isLatinScript: false,
            lyricsNative:
              '[Verse]\nपहली पंक्ति\nदूसरी पंक्ति\nतीसरी पंक्ति\nचौथी पंक्ति',
            lyricsRoman:
              '[Verse]\nPehli pankti\nDoosri pankti\nTeesri pankti\nChauthi pankti',
          },
        },
        setlist: [],
      },
    });
  });
  const audio = page.locator('audio');
  await audio.evaluate((element) =>
    element.dispatchEvent(new Event('loadedmetadata')),
  );
  await expect(page.getByText('Playing with the host')).toBeVisible();

  await page.evaluate(() => {
    (
      window as typeof window & { __mediaCurrentTime?: number }
    ).__mediaCurrentTime = 70;
  });

  await expect(
    page.getByRole('progressbar', { name: 'Song progress' }),
  ).toHaveAttribute('aria-valuenow', '70');
  await expect(page.getByText('1:10 / 2:00')).toBeVisible();
  await expect(page.locator('.lyric-primary')).not.toHaveText('पहली पंक्ति');
  await expect(page.locator('.record-mark')).toHaveText('M');
  await expect
    .poll(() =>
      page
        .locator('.record')
        .evaluate((element) => getComputedStyle(element).animationPlayState),
    )
    .toBe('running');
});

test('the browser does not expose the token outside the paid request body', async ({
  page,
}) => {
  const token = 'sk-fixture-secret-token';
  const requestedUrls: string[] = [];
  page.on('request', (request) => requestedUrls.push(request.url()));
  await page.goto('/');
  await fillSong(page);
  await page.getByRole('button', { name: 'Start the mehfil' }).click();
  await expect(page.getByText('Your recording is ready.')).toBeVisible();
  expect(requestedUrls.join('\n')).not.toContain(token);
  const browserState = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
    body: document.body.innerText,
  }));
  expect(JSON.stringify(browserState)).not.toContain(token);
});
