import { expect, test, type Page } from '@playwright/test';

import { createRoomState } from '../../src/room/state.ts';
import {
  installWebSocketHarness,
  projectHostFixture,
} from '../fixtures/websocket-harness.ts';

const sharedSongId = 'AbCdEfGhIjKlMnOp';

async function fillSong(page: Page) {
  await page.getByLabel(/MiniMax token/).fill('sk-fixture-secret-token');
  await page.getByLabel(/What's the song about\?/).fill('Monsoon Song');
}

async function sentFrames(page: Page) {
  return page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ sent: string[] }>;
    };
    return fixtureWindow.__mehfilSockets.flatMap((socket) =>
      socket.sent.map((frame) => JSON.parse(frame) as unknown),
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
  await expect(lyricToggle).toBeVisible();
  if ((await lyricToggle.innerText()).includes('Hide'))
    await lyricToggle.click();
  await lyricToggle.click();
  await expect(page.getByText('बारिश की रात')).toBeVisible();
  await expect(page.getByText('Baarish ki raat')).toBeVisible();

  await page.getByRole('button', { name: 'Share this song' }).click();
  await expect(
    page.getByRole('button', { name: 'Share this song' }),
  ).toContainText('Copied');
  expect(
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
    const fixtureWindow = window as typeof window & {
      __mehfilSockets: Array<{ serverMessage(value: unknown): void }>;
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
  await expect(page.getByText('Your recording is ready.')).toBeVisible();

  const messages = (await sentFrames(page)) as Array<{
    type?: string;
    participantId?: string;
    requestId?: string;
    toIndex?: number;
    shareId?: string;
  }>;
  expect(messages).toEqual(
    expect.arrayContaining([
      { type: 'kicked', participantId: 'listener-1' },
      { type: 'request-accepted', requestId: 'request-1' },
      { type: 'request-reordered', requestId: 'request-1', toIndex: 1 },
      { type: 'request-declined', requestId: 'request-1' },
      { type: 'recording-started', requestId: 'request-2' },
      expect.objectContaining({
        type: 'lyrics-ready',
        requestId: 'request-2',
      }),
      {
        type: 'song-ready',
        requestId: 'request-2',
        shareId: sharedSongId,
      },
    ]),
  );
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
  const resumed = (await sentFrames(page)) as Array<Record<string, unknown>>;
  expect(resumed[0]).toEqual({ type: 'join', resume: 'resume-fixture' });
  await expect(
    page.getByRole('button', { name: 'Join the mehfil' }),
  ).toBeHidden();
});

test('shared playback refreshes progress and lyrics between media events', async ({
  page,
}) => {
  await page.addInitScript(() => {
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
    await page.evaluate(
      () => (window as typeof window & { __copiedText?: string }).__copiedText,
    ),
  ).toBe(`http://127.0.0.1:4387/s/${sharedSongId}`);
});
