import { expect, test } from '@playwright/test';

import { installWebSocketHarness } from '../fixtures/websocket-harness.ts';

test('player controls use SVG icons instead of platform-dependent glyphs', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.scene-root > .scene svg')).toHaveAttribute(
    'viewBox',
    '0 0 1600 1000',
  );
  await expect(page.locator('#play svg.play-icon')).toHaveCount(1);
  await expect(page.locator('#play svg.pause-icon')).toHaveCount(1);
  await expect(page.locator('#share svg.player-icon')).toHaveCount(1);
  await expect(page.locator('#download svg.download-icon')).toHaveCount(1);
  await expect(page.locator('#seek')).toBeVisible();
  await expect(page.locator('#timecode')).toHaveText('0:00 / 0:00');
});

test('host panel follows the song composer in the primary task column', async ({
  page,
}) => {
  await installWebSocketHarness(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Open this mehfil to friends' })
    .click();
  await expect(page.locator('#room-panel')).toBeVisible();
  const followsComposer = await page.evaluate(() => {
    const form = document.querySelector('#song-form');
    const panel = document.querySelector('#room-panel');
    return Boolean(
      form &&
      panel &&
      form.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(followsComposer).toBe(true);
  await expect(page.getByRole('heading', { name: 'Listeners' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Setlist' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close room' })).toBeVisible();
});
