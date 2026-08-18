import { expect, test, type Page } from '@playwright/test';

import {
  isRecord,
  type JsonRecord,
  type JsonValue,
} from '../../src/room/primitives.ts';
import { createRoomState, projectRoomState } from '../../src/room/state.ts';
import { playbackPage } from '../../src/worker/playback-page.ts';
import {
  installWebSocketHarness,
  projectHostFixture,
} from '../fixtures/websocket-harness.ts';

const sharedSongId = 'AbCdEfGhIjKlMnOp';
const fixtureToken = 'sk-fixture-secret-token';

const timedLyrics = {
  title: 'Timed Rain',
  language: 'English',
  nativeScriptName: 'Latin',
  isLatinScript: true,
  lyricsNative:
    '[Verse]\nRain begins\nSoft drums answer\n[Chorus]\nSing again\nFind the morning',
  lyricsRoman:
    '[Verse]\nRain begins\nSoft drums answer\n[Chorus]\nSing again\nFind the morning',
};

const timedArtifact = {
  version: 1 as const,
  mode: 'minimax-section-asr' as const,
  durationSeconds: 24,
  segments: [
    { start: 0, end: 12, label: 'verse' as const },
    { start: 12, end: 24, label: 'chorus' as const },
  ],
};

async function installTimingBrowserHarness(
  page: Page,
  { currentTime = 6, duration = 24 } = {},
) {
  await page.addInitScript(
    ({ initialTime, mediaDuration }) => {
      // SAFETY: the defineProperties calls below read and write
      // __mediaCurrentTime / __mediaPaused on window, establishing the
      // properties this cast declares.
      const fixtureWindow = window as typeof window & {
        __mediaCurrentTime?: number;
        __mediaPaused?: boolean;
      };
      fixtureWindow.__mediaCurrentTime = initialTime;
      fixtureWindow.__mediaPaused = true;
      Object.defineProperties(HTMLMediaElement.prototype, {
        currentTime: {
          configurable: true,
          get: () => fixtureWindow.__mediaCurrentTime ?? 0,
          set: (value: number) => {
            fixtureWindow.__mediaCurrentTime = value;
          },
        },
        duration: { configurable: true, get: () => mediaDuration },
        paused: {
          configurable: true,
          get: () => fixtureWindow.__mediaPaused ?? true,
        },
        ended: { configurable: true, get: () => false },
        readyState: { configurable: true, get: () => 1 },
      });
      HTMLMediaElement.prototype.load = function () {
        queueMicrotask(() => {
          this.dispatchEvent(new Event('loadedmetadata'));
          this.dispatchEvent(new Event('durationchange'));
        });
      };
      HTMLMediaElement.prototype.play = function () {
        fixtureWindow.__mediaPaused = false;
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function () {
        fixtureWindow.__mediaPaused = true;
        this.dispatchEvent(new Event('pause'));
      };
    },
    { initialTime: currentTime, mediaDuration: duration },
  );
}

async function fillSong(page: Page) {
  await page.getByLabel(/MiniMax token/).fill(fixtureToken);
  await page.getByLabel(/What's the song about\?/).fill('Monsoon Song');
}

async function sentFrames(page: Page): Promise<JsonValue[]> {
  return page.evaluate(() => {
    // SAFETY: the WebSocket harness installed by installWebSocketHarness
    // exposes __mehfilSockets on window via addInitScript.
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ sent: string[] }>;
    };
    return fixtureWindow.__mehfilSockets.flatMap((socket) =>
      socket.sent.map((frame) => JSON.parse(frame)),
    );
  });
}

test('a generated song can be revealed, shared, and reopened', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value: string) {
          // SAFETY: the clipboard stub in this addInitScript writes
          // __copiedText onto window, establishing the property this cast
          // declares.
          (window as typeof window & { __copiedText?: string }).__copiedText =
            value;
          return Promise.resolve();
        },
      },
    });
    HTMLMediaElement.prototype.play = function () {
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
  });

  await page.goto('/');
  await fillSong(page);
  await page.getByRole('button', { name: 'Start the mehfil' }).click();

  await expect(page.getByText('Your recording is ready.')).toBeVisible();
  const lyricToggle = page.locator('#peek-toggle');
  await expect(lyricToggle).toBeHidden();
  await expect(page.getByText('बारिश की रात')).toBeVisible();
  await expect(page.getByText('Baarish ki raat')).toBeVisible();

  await page.getByRole('button', { name: 'Share this song' }).click();
  await expect(
    page.getByRole('button', { name: 'Share this song' }),
  ).toContainText('Copied');
  expect(
    // SAFETY: the clipboard stub installed above writes __copiedText onto
    // window, so the cast reads the value the stub recorded.
    await page.evaluate(
      () => (window as typeof window & { __copiedText?: string }).__copiedText,
    ),
  ).toBe(`https://public.example.test/s/${sharedSongId}`);
  await expect(
    page.getByRole('link', { name: 'Save this song' }),
  ).toHaveAttribute('href', /^blob:/);

  await page.getByRole('button', { name: 'Close performance' }).click();
  const reopen = page.getByRole('button', { name: 'View performance' });
  await reopen.click();
  await expect(
    page.getByRole('dialog', { name: 'Your mehfil performance' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('dialog', { name: 'Your mehfil performance' }),
  ).toBeHidden();
  await expect(reopen).toBeFocused();
});

test('playing timed lyrics ignore an earlier manual full-sheet reveal', async ({
  page,
}) => {
  let releaseGeneration: (() => void) | undefined;
  const generationHeld = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.load = function () {
      Object.defineProperty(this, 'duration', {
        configurable: true,
        value: 24,
      });
      Object.defineProperty(this, 'currentTime', {
        configurable: true,
        value: 5,
        writable: true,
      });
      queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
    };
    HTMLMediaElement.prototype.play = function () {
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
  });
  await page.route('**/api/write-lyrics', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        title: 'Timed Rain',
        language: 'English',
        nativeScriptName: 'Latin',
        isLatinScript: true,
        lyricsNative: '[Verse]\nRain begins\n[Chorus]\nSing again',
        lyricsRoman: '[Verse]\nRain begins\n[Chorus]\nSing again',
        prompt: 'Warm acoustic mehfil',
      }),
    });
  });
  await page.route('**/api/generate', async (route) => {
    await generationHeld;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: { audio: '49443304000000000000' },
        lyric_timing: {
          version: 1,
          mode: 'minimax-section-asr',
          durationSeconds: 24,
          segments: [
            { start: 0, end: 12, label: 'verse' },
            { start: 12, end: 24, label: 'chorus' },
          ],
        },
      }),
    });
  });

  await page.goto('/');
  await fillSong(page);
  await page.getByRole('button', { name: 'Start the mehfil' }).click();
  const lyricToggle = page.locator('#peek-toggle');
  await expect(lyricToggle).toContainText('Reveal lyrics');
  await lyricToggle.click();
  await expect(lyricToggle).toContainText('Hide lyrics');
  await expect(page.getByText('Verse')).toBeVisible();
  await expect(page.getByText('Chorus')).toBeVisible();

  releaseGeneration?.();
  await expect(page.getByText('Your recording is ready.')).toBeVisible();

  await expect(page.locator('#lyric-reveal .lyric-section')).toHaveCount(1);
  await expect(page.getByText('Verse')).toBeVisible();
  await expect(page.getByText('Chorus')).toHaveCount(0);
  await expect(lyricToggle).toBeHidden();

  const audio = page.locator('audio');
  await audio.evaluate((element) => element.dispatchEvent(new Event('pause')));
  await expect(lyricToggle).toBeHidden();
  await expect(page.locator('#lyric-reveal .lyric-section')).toHaveCount(1);
  await audio.evaluate((element) => element.dispatchEvent(new Event('ended')));
  await expect(lyricToggle).toBeHidden();
  await expect(page.locator('#lyric-reveal .lyric-section')).toHaveCount(1);
});

test('ready untimed lyrics resume progressive reveal after a manual preview', async ({
  page,
}) => {
  let releaseGeneration: (() => void) | undefined;
  const generationHeld = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.load = function () {
      Object.defineProperty(this, 'duration', {
        configurable: true,
        value: 24,
      });
      Object.defineProperty(this, 'currentTime', {
        configurable: true,
        value: 6,
        writable: true,
      });
      queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
    };
    HTMLMediaElement.prototype.play = function () {
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
  });
  await page.route('**/api/write-lyrics', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        title: 'Untimed Rain',
        language: 'English',
        nativeScriptName: 'Latin',
        isLatinScript: true,
        lyricsNative: '[Verse]\nRain begins\n[Chorus]\nSing again',
        lyricsRoman: '[Verse]\nRain begins\n[Chorus]\nSing again',
        prompt: 'Warm acoustic mehfil',
      }),
    });
  });
  await page.route('**/api/generate', async (route) => {
    await generationHeld;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { audio: '49443304000000000000' } }),
    });
  });

  await page.goto('/');
  await fillSong(page);
  await page.getByRole('button', { name: 'Start the mehfil' }).click();
  const lyricToggle = page.locator('#peek-toggle');
  await lyricToggle.click();
  await expect(page.getByText('Chorus')).toBeVisible();
  await expect(page.getByText('Sing again')).toBeVisible();

  releaseGeneration?.();
  await expect(page.getByText('Your recording is ready.')).toBeVisible();

  await expect(lyricToggle).toBeHidden();
  await expect(page.getByText('Verse')).toBeVisible();
  await expect(page.getByText('Rain begins')).toBeVisible();
  await expect(page.getByText('Chorus')).toBeHidden();
  await expect(page.getByText('Sing again')).toBeHidden();
  await page
    .locator('audio')
    .evaluate((element) => element.dispatchEvent(new Event('pause')));
  await expect(lyricToggle).toBeHidden();
  await expect(page.getByText('Chorus')).toBeHidden();
});

test('a host manages a request through recording and publication', async ({
  page,
}) => {
  await installWebSocketHarness(page);
  await page.goto('/');
  await page.getByLabel(/MiniMax token/).fill('sk-fixture-secret-token');
  await page
    .getByRole('button', { name: 'Open this mehfil to friends' })
    .click();
  await expect(page.getByText('connected')).toBeVisible();

  const timestamp = Date.now();
  const roomState = createRoomState({
    roomId: 'ABCDEFGH',
    openedAt: timestamp,
    expiresAt: timestamp + 60_000,
  });
  roomState.hostPresent = true;
  roomState.participants.push({
    id: 'listener-1',
    name: 'Asha',
    connected: true,
    joinedAt: timestamp,
  });
  roomState.queue.push(
    {
      id: 'request-1',
      participantId: 'listener-1',
      idea: 'Rain on the old roof',
      vibe: 'acoustic',
      language: 'Hindi',
      status: 'pending',
      submittedAt: timestamp,
    },
    {
      id: 'request-2',
      participantId: 'listener-1',
      idea: 'Night drive home',
      vibe: 'warm',
      language: 'Gujarati',
      status: 'accepted',
      submittedAt: timestamp + 1,
    },
  );
  await page.evaluate((state) => {
    // SAFETY: the WebSocket harness installed by installWebSocketHarness
    // defines __mehfilSockets on window with a serverMessage method.
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ serverMessage(value: JsonValue): void }>;
    };
    fixtureWindow.__mehfilSockets[0]?.serverMessage({
      type: 'snapshot',
      state,
    });
  }, projectHostFixture(roomState));

  const participant = page
    .locator('#host-participants li')
    .filter({ hasText: 'Asha' });
  await participant.getByRole('button', { name: 'Kick' }).click();

  const pending = page
    .locator('#host-queue li')
    .filter({ hasText: 'Rain on the old roof' });
  await pending.getByRole('button', { name: 'Accept' }).click();
  await pending
    .getByRole('button', { name: 'Move Rain on the old roof down' })
    .click();
  await pending.getByRole('button', { name: 'Decline' }).click();

  const accepted = page
    .locator('#host-queue li')
    .filter({ hasText: 'Night drive home' });
  await accepted.getByRole('button', { name: 'Record' }).click();

  await expect
    .poll(async () =>
      (await sentFrames(page)).some(
        (frame) => isRecord(frame) && frame.type === 'recording-enqueued',
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    // SAFETY: the WebSocket harness installed by installWebSocketHarness
    // defines __mehfilSockets on window with a serverMessage method.
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ serverMessage(value: JsonValue): void }>;
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
        listenerCount: 0,
        participants: [],
        queue: [
          {
            id: 'request-1',
            participantId: 'listener-1',
            requesterName: 'Asha',
            idea: 'Rain on the old roof',
            vibe: 'acoustic',
            language: 'Hindi',
            status: 'declined',
            submittedAt: 1,
          },
          {
            id: 'request-2',
            participantId: 'listener-1',
            requesterName: 'Asha',
            idea: 'Night drive home',
            vibe: 'warm',
            language: 'Gujarati',
            status: 'queued',
            submittedAt: 2,
          },
        ],
        recordingQueue: ['request-2'],
        currentRecording: null,
        currentSong: null,
        setlist: [],
      },
    });
  });

  await expect
    .poll(async () =>
      (await sentFrames(page)).find(
        (frame) => isRecord(frame) && frame.type === 'recording-started',
      ),
    )
    .toBeTruthy();
  const recordingStarted = (await sentFrames(page)).find(
    (frame): frame is JsonRecord =>
      isRecord(frame) && frame.type === 'recording-started',
  );
  if (!recordingStarted?.coordinatorId)
    throw new Error('Host did not claim the queued recording');
  // SAFETY: the host app generates coordinator ids as non-empty strings in
  // recording-started frames, and the guard above already rejected falsy
  // values before this assertion.
  const coordinatorId = recordingStarted.coordinatorId as string;

  await page.evaluate((coordinatorId) => {
    // SAFETY: the WebSocket harness installed by installWebSocketHarness
    // defines __mehfilSockets on window with a serverMessage method.
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ serverMessage(value: JsonValue): void }>;
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
        listenerCount: 0,
        participants: [],
        queue: [
          {
            id: 'request-1',
            participantId: 'listener-1',
            requesterName: 'Asha',
            idea: 'Rain on the old roof',
            vibe: 'acoustic',
            language: 'Hindi',
            status: 'declined',
            submittedAt: 1,
          },
          {
            id: 'request-2',
            participantId: 'listener-1',
            requesterName: 'Asha',
            idea: 'Night drive home',
            vibe: 'warm',
            language: 'Gujarati',
            status: 'recording',
            submittedAt: 2,
          },
        ],
        recordingQueue: [],
        currentRecording: {
          requestId: 'request-2',
          coordinatorId,
          startedAt: Date.now(),
          lyrics: null,
        },
        currentSong: null,
        setlist: [],
      },
    });
  }, coordinatorId);
  await expect(page.getByText('Your recording is ready.')).toBeVisible();

  const messages = (await sentFrames(page)).filter(isRecord);
  expect(messages).toEqual(
    expect.arrayContaining([
      { type: 'kicked', participantId: 'listener-1' },
      { type: 'request-accepted', requestId: 'request-1' },
      { type: 'request-reordered', requestId: 'request-1', toIndex: 1 },
      { type: 'request-declined', requestId: 'request-1' },
      { type: 'recording-enqueued', requestId: 'request-2' },
      expect.objectContaining({
        type: 'recording-started',
        requestId: 'request-2',
      }),
      expect.objectContaining({
        type: 'lyrics-ready',
        requestId: 'request-2',
      }),
      {
        type: 'song-ready',
        requestId: 'request-2',
        shareId: sharedSongId,
        lyricTiming: null,
      },
    ]),
  );
});

test('delayed timing upgrades host, listener, and shared playback at the same media clock', async ({
  page,
  context,
}) => {
  let releaseAnalysis: (() => void) | undefined;
  const analysisHeld = new Promise<void>((resolve) => {
    releaseAnalysis = resolve;
  });
  let shareCalls = 0;
  const sharedBodies: Array<JsonRecord> = [];

  await installWebSocketHarness(page);
  await installTimingBrowserHarness(page);
  await page.route('**/api/write-lyrics', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...timedLyrics,
        prompt: 'Warm acoustic mehfil',
      }),
    }),
  );
  await page.route('**/api/generate', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: { audio: 'https://audio.example.test/timed-song.mp3' },
        share_ref: 'AbCdEfGhIjKlMnOpQrStUvWx',
      }),
    }),
  );
  await page.route('**/api/analyze-timing', async (route) => {
    await analysisHeld;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ready', timing: timedArtifact }),
    });
  });
  await page.route('**/api/share', async (route) => {
    shareCalls += 1;
    // SAFETY: the app's share POST body is app-authored JSON; the test only
    // compares its lyricTiming field.
    sharedBodies.push(route.request().postDataJSON() as JsonRecord);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        url: `http://127.0.0.1:4387/s/${sharedSongId}`,
      }),
    });
  });
  await page.route('https://audio.example.test/**', (route) =>
    route.fulfill({ contentType: 'audio/mpeg', body: 'ID3' }),
  );

  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open this mehfil to friends' })
    .click();
  await expect(page.getByText('connected')).toBeVisible();
  await fillSong(page);
  await page.getByRole('button', { name: 'Start the mehfil' }).click();

  await expect(page.getByText('Your recording is ready.')).toBeVisible();
  await expect(
    page.getByText('Analyzing MiniMax sections · music is ready'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  // SAFETY: the locator('audio') targets the page's <audio> player element,
  // so the evaluated element is an HTMLAudioElement exposing currentTime.
  expect(
    await page
      .locator('audio')
      .evaluate((audio) => (audio as HTMLAudioElement).currentTime),
  ).toBe(6);
  expect(shareCalls).toBe(0);
  releaseAnalysis?.();
  await expect(
    page.getByText('Lines follow MiniMax sections · timing is approximate'),
  ).toBeVisible();
  await expect(page.locator('#lyric-reveal .lyric-section')).toHaveCount(1);
  await expect(page.locator('#lyric-reveal [aria-current="true"]')).toHaveCount(
    1,
  );
  const hostLine = await page
    .locator('#lyric-reveal [aria-current="true"] .lyric-primary')
    .textContent();
  expect(hostLine).toBeTruthy();
  // SAFETY: the same <audio> player element as above, re-read after the
  // timing upgrade to prove the media clock did not reset.
  expect(
    await page
      .locator('audio')
      .evaluate((audio) => (audio as HTMLAudioElement).currentTime),
  ).toBe(6);
  await expect.poll(() => shareCalls).toBe(1);
  expect(sharedBodies[0]?.lyricTiming).toEqual(timedArtifact);
  await expect
    .poll(async () =>
      (await sentFrames(page)).find(
        (frame) => isRecord(frame) && frame.type === 'song-shared',
      ),
    )
    .toEqual(
      expect.objectContaining({
        type: 'song-shared',
        shareId: sharedSongId,
        lyricTiming: timedArtifact,
      }),
    );

  const listenerState = createRoomState({
    roomId: 'ABCDEFGH',
    openedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  listenerState.hostPresent = true;
  listenerState.participants.push({
    id: 'listener-fixture',
    name: 'Listener',
    connected: true,
    joinedAt: Date.now(),
  });
  listenerState.currentSong = {
    requestId: null,
    shareId: sharedSongId,
    title: timedLyrics.title,
    language: timedLyrics.language,
    startedAt: Date.now(),
    lyrics: timedLyrics,
    lyricTiming: timedArtifact,
    playback: { status: 'paused', positionMs: 6_000, changedAt: Date.now() },
  };
  const listenerSnapshot = projectRoomState(listenerState, {
    role: 'listener',
    participantId: 'listener-fixture',
  });
  const listener = await context.newPage();
  await installWebSocketHarness(listener);
  await installTimingBrowserHarness(listener);
  await listener.goto('/r/ABCDEFGH');
  await listener.getByLabel('Your name').fill('Listener');
  await listener.getByRole('button', { name: 'Join the mehfil' }).click();
  await listener.evaluate((state) => {
    // SAFETY: the WebSocket harness installed by installWebSocketHarness
    // defines __mehfilSockets on window with a serverMessage method.
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ serverMessage(value: JsonValue): void }>;
    };
    fixtureWindow.__mehfilSockets[0]?.serverMessage({
      type: 'snapshot',
      state,
    });
  }, listenerSnapshot);
  await expect(
    listener.locator('.lyric-performance .lyric-section'),
  ).toHaveCount(1);
  await expect(
    listener.locator('.lyric-performance [aria-current="true"]'),
  ).toHaveCount(1);
  const listenerLine = await listener
    .locator('.lyric-performance [aria-current="true"] .lyric-primary')
    .textContent();
  expect(listenerLine).toBe(hostLine);

  const standalone = await context.newPage();
  await installTimingBrowserHarness(standalone);
  await standalone.route(`**/s/${sharedSongId}`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: playbackPage(
        sharedSongId,
        { ...timedLyrics, lyricTiming: timedArtifact },
        'fixture-nonce',
        'http://127.0.0.1:4387',
        '',
      ),
    }),
  );
  await standalone.goto(`/s/${sharedSongId}`);
  await standalone
    .locator('audio')
    .evaluate((audio) => audio.dispatchEvent(new Event('loadedmetadata')));
  await expect(
    standalone.locator('#reveal-lines [aria-current="true"]'),
  ).toHaveCount(1);
  const standaloneLine = await standalone
    .locator('#reveal-lines [aria-current="true"] .lyric-primary')
    .textContent();
  expect(standaloneLine).toBe(hostLine);
});

test('a listener submits a request and resumes the same seat after reload', async ({
  page,
}) => {
  await installWebSocketHarness(page);
  await page.goto('/r/ABCDEFGH');
  await page.getByLabel('Your name').fill('Listener');
  await page.getByRole('button', { name: 'Join the mehfil' }).click();
  await expect(page.getByText('The host is here.')).toBeVisible();

  await page.locator('summary').getByText('Request a song').click();
  await page.getByLabel(/What's the song about\?/).fill('A train at sunrise');
  await page.getByLabel(/Vibe/).fill('hopeful');
  await page.getByLabel('Language').selectOption('Gujarati');
  await page.getByRole('button', { name: 'Send request' }).click();

  expect(await sentFrames(page)).toContainEqual({
    type: 'request-submitted',
    idea: 'A train at sunrise',
    vibe: 'hopeful',
    language: 'Gujarati',
  });
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem('mini-mehfil-room:ABCDEFGH'),
    ),
  ).toBe('resume-fixture');

  await page.reload();
  await expect(page.getByText('The host is here.')).toBeVisible();
  const resumed = (await sentFrames(page)).filter(isRecord);
  expect(resumed[0]).toEqual({ type: 'join', resume: 'resume-fixture' });
  await expect(
    page.getByRole('button', { name: 'Join the mehfil' }),
  ).toBeHidden();
});

test('shared playback refreshes progress and lyrics between media events', async ({
  page,
}) => {
  await page.addInitScript(() => {
    // SAFETY: the defineProperties calls below read and write
    // __mediaCurrentTime / __mediaPaused (and the clipboard stub writes
    // __copiedText) on window, establishing the properties this cast declares.
    const media = window as typeof window & {
      __copiedText?: string;
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
      duration: { configurable: true, get: () => 100 },
      paused: { configurable: true, get: () => media.__mediaPaused ?? true },
      ended: { configurable: true, get: () => false },
      readyState: { configurable: true, get: () => 1 },
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
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value: string) {
          media.__copiedText = value;
          return Promise.resolve();
        },
      },
    });
  });

  await page.goto(`/s/${sharedSongId}`);
  await page.getByRole('button', { name: 'Play Aloopuri Khavsa' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

  await page.evaluate(() => {
    // SAFETY: the media-clock init script installed above defines
    // __mediaCurrentTime on window.
    (
      window as typeof window & { __mediaCurrentTime?: number }
    ).__mediaCurrentTime = 50;
  });
  await expect(page.getByRole('slider', { name: 'Seek' })).toHaveValue('50');
  await expect(page.locator('.lyric-line:not([hidden])')).not.toHaveCount(0);

  await page.getByRole('button', { name: 'Copy this song link' }).click();
  await expect(
    page.getByRole('button', { name: 'Copy this song link' }),
  ).toContainText('Copied');
  expect(
    // SAFETY: the clipboard stub installed above writes __copiedText onto
    // window, so the cast reads the value the stub recorded.
    await page.evaluate(
      () => (window as typeof window & { __copiedText?: string }).__copiedText,
    ),
  ).toBe(`http://127.0.0.1:4387/s/${sharedSongId}`);
});
