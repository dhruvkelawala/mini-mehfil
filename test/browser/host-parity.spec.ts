import { expect, test } from '@playwright/test';

import { installWebSocketHarness } from '../fixtures/websocket-harness.ts';

test('player controls use SVG icons instead of platform-dependent glyphs', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.scene-root > .scene')).toHaveCount(1);
  await expect(page.locator('.scene-root svg')).toHaveCount(0);
  await expect(page.locator('#play svg.play-icon')).toHaveCount(1);
  await expect(page.locator('#play svg.pause-icon')).toHaveCount(1);
  await expect(page.locator('#share svg.player-icon')).toHaveCount(1);
  await expect(page.locator('#download svg.download-icon')).toHaveCount(1);
  await expect(page.locator('#seek')).toBeVisible();
  await expect(page.locator('#timecode')).toHaveText('0:00 / 0:00');
});

test('token help takes new hosts directly to the MiniMax key flow', async ({
  page,
}) => {
  const mobile = (page.viewportSize()?.width ?? 0) <= 560;
  if (!mobile) await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'Where do I get this?' });

  await opener.click();

  const help = page.getByRole('dialog', { name: 'Get a MiniMax API key' });
  await expect(help).toBeVisible();
  await expect(help).toHaveAttribute('aria-modal', 'true');
  await expect(opener).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await expect(page.locator('#player-shell')).toHaveAttribute('inert', '');
  await expect(help.getByText('Create or sign in to MiniMax.')).toBeVisible();
  await expect(
    help.getByText('Open API Keys and create a secret key.'),
  ).toBeVisible();
  await expect(
    help.getByText('Copy the key and paste it above.'),
  ).toBeVisible();
  await expect(
    help.getByRole('link', { name: 'Open MiniMax API Keys' }),
  ).toHaveAttribute(
    'href',
    'https://platform.minimax.io/docs/faq/about-apis#q-obtaining-your-api-key',
  );
  await expect(page.getByText(/never saved/i)).toHaveCount(1);

  await expect
    .poll(() => help.evaluate((element) => getComputedStyle(element).position))
    .toBe('fixed');
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if ((viewport?.width ?? 0) <= 560) {
    await expect
      .poll(async () => {
        const box = await help.boundingBox();
        return Math.abs(
          (box?.y ?? 0) + (box?.height ?? 0) - (viewport?.height ?? 0),
        );
      })
      .toBeLessThan(1);
    const helpBox = await help.boundingBox();
    expect(helpBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(300);
  } else {
    const helpBox = await help.boundingBox();
    expect(helpBox).not.toBeNull();
    const openerBox = await opener.boundingBox();
    expect(
      (helpBox?.y ?? 0) - ((openerBox?.y ?? 0) + (openerBox?.height ?? 0)),
    ).toBeLessThan(40);
    expect((helpBox?.y ?? 0) + (helpBox?.height ?? 0)).toBeLessThanOrEqual(
      viewport?.height ?? 0,
    );
  }

  await page.evaluate(() =>
    document.querySelector<HTMLElement>('#open-room')?.focus(),
  );
  await expect(
    help.getByRole('button', { name: 'Close MiniMax key help' }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    help.getByRole('link', { name: 'Open MiniMax API Keys' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    help.getByRole('button', { name: 'Close MiniMax key help' }),
  ).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await expect(opener).toBeFocused();
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
