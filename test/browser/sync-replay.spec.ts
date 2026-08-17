import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createRoomState, projectRoomState } from '../../src/room/state.ts';
import { installWebSocketHarness } from '../fixtures/websocket-harness.ts';

const sharedSongId = 'AbCdEfGhIjKlMnOp';
const replaySong = JSON.parse(
  readFileSync(
    new URL('../fixtures/sync-replay-song.json', import.meta.url),
    'utf8',
  ),
) as {
  lyrics: {
    title: string;
    language: string;
    nativeScriptName: string;
    isLatinScript: boolean;
    lyricsNative: string;
    lyricsRoman: string;
  };
  timing: {
    version: 1;
    mode: 'minimax-section-asr';
    durationSeconds: number;
    segments: Array<{
      start: number;
      end: number;
      label: 'verse' | 'chorus' | 'outro';
    }>;
  };
};

async function installProofCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proof = window as typeof window & {
      __copiedText?: string;
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value: string) {
          proof.__copiedText = value;
          return Promise.resolve();
        },
      },
    });
  });
}

async function seekActive(
  page: Page,
  stage: string,
  seconds: number,
): Promise<{ section: string; line: string }> {
  const audio = page.locator('audio');
  await audio.evaluate((element, time) => {
    const media = element as HTMLAudioElement;
    media.currentTime = time;
    media.dispatchEvent(new Event('timeupdate'));
    media.dispatchEvent(new Event('seeked'));
  }, seconds);
  const current = page.locator(`${stage} [aria-current="true"]`);
  await expect(current).toHaveCount(1);
  const line = await current.locator('.lyric-primary').textContent();
  const section = await page
    .locator(`${stage} .lyric-cue`)
    .first()
    .textContent();
  return { section: section?.trim() ?? '', line: line?.trim() ?? '' };
}

test('local MiniMax replay keeps host, listener, and share on one real-audio clock', async ({
  page,
  context,
}) => {
  test.skip(!process.env.MEHFIL_REPLAY_AUDIO, 'Set MEHFIL_REPLAY_AUDIO');

  await installProofCapture(page);
  await page.goto('/');
  await page.getByLabel(/MiniMax token/).fill('sk-local-replay');
  await page.getByLabel(/What's the song about\?/).fill('Local replay fixture');
  await page.getByRole('button', { name: 'Start the mehfil' }).click();

  await expect(page.getByText('Your recording is ready.')).toBeVisible();
  await expect(
    page.getByText('Analyzing MiniMax sections · music is ready'),
  ).toBeVisible();
  await page.waitForTimeout(350);
  const hostAudio = page.locator('audio');
  await expect
    .poll(() =>
      hostAudio.evaluate((element) => (element as HTMLAudioElement).duration),
    )
    .toBeGreaterThan(150);
  const sourceBeforeUpgrade = await hostAudio.evaluate(
    (element) => (element as HTMLAudioElement).currentSrc,
  );
  const releaseTiming = await page.request.post('/__fixture/release-timing');
  expect(releaseTiming.ok()).toBe(true);

  await expect(
    page.getByText('Lines follow MiniMax sections · timing is approximate'),
  ).toBeVisible();
  await page.waitForTimeout(350);
  expect(
    await hostAudio.evaluate(
      (element) => (element as HTMLAudioElement).currentSrc,
    ),
  ).toBe(sourceBeforeUpgrade);

  await page.getByRole('button', { name: 'Share this song' }).click();
  await expect(
    page.getByRole('button', { name: 'Share this song' }),
  ).toContainText('Copied');

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
    title: replaySong.lyrics.title,
    language: replaySong.lyrics.language,
    startedAt: Date.now(),
    lyrics: replaySong.lyrics,
    lyricTiming: replaySong.timing,
    playback: { status: 'paused', positionMs: 10_000, changedAt: Date.now() },
  };

  const listener = await context.newPage();
  await installProofCapture(listener);
  await installWebSocketHarness(listener, {
    listener: projectRoomState(listenerState, {
      role: 'listener',
      participantId: 'listener-fixture',
    }),
  });
  await listener.goto('/r/ABCDEFGH');
  await listener.getByLabel('Your name').fill('Listener');
  await listener.getByRole('button', { name: 'Join the mehfil' }).click();
  await expect(
    listener.locator('.lyric-performance .lyric-section'),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      listener
        .locator('audio')
        .evaluate((element) => (element as HTMLAudioElement).duration),
    )
    .toBeGreaterThan(150);

  const standalone = await context.newPage();
  await installProofCapture(standalone);
  await standalone.goto(`/s/${sharedSongId}`);
  await expect(standalone.locator('#reveal-lines .lyric-section')).toHaveCount(
    1,
  );
  await expect
    .poll(() =>
      standalone
        .locator('audio')
        .evaluate((element) => (element as HTMLAudioElement).duration),
    )
    .toBeGreaterThan(150);

  const samples = [
    { seconds: 10, expected: 'Replay verse one' },
    { seconds: 115, expected: 'Replay chorus two' },
    { seconds: 55, expected: 'Replay verse two' },
  ];
  for (const sample of samples) {
    const [host, live, shared] = await Promise.all([
      seekActive(page, '#lyric-reveal', sample.seconds),
      seekActive(listener, '.lyric-performance', sample.seconds),
      seekActive(standalone, '#reveal-lines', sample.seconds),
    ]);
    expect(host.line).toBe(sample.expected);
    expect(live).toEqual(host);
    expect(shared).toEqual(host);
    await page.waitForTimeout(350);
  }

  const replayState = await page.request.get('/__fixture/replay-state');
  expect(replayState.ok()).toBe(true);
  expect(await replayState.json()).toEqual(
    expect.objectContaining({
      replay: true,
      generationRequests: 1,
      timingRequests: 1,
      shareRequests: 1,
      timingReleased: true,
    }),
  );
  const videoDirectory = process.env.MEHFIL_REPLAY_VIDEO_DIR;
  if (videoDirectory) {
    mkdirSync(videoDirectory, { recursive: true });
    for (const [name, proofPage] of [
      ['host', page],
      ['listener', listener],
      ['shared', standalone],
    ] as const) {
      const video = proofPage.video();
      await proofPage.close();
      await video?.saveAs(join(videoDirectory, `${name}.webm`));
    }
  }
});
