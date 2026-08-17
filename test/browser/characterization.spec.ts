import { expect, test } from '@playwright/test';

import { installWebSocketHarness } from '../fixtures/websocket-harness.ts';

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
