import { describe, expect, test } from 'vitest';

import { roomPage } from '../../src/worker/room-page.ts';
import type { RoomDirectory } from '../../src/worker/rooms.ts';
import { createRoomRouter } from '../../src/worker/rooms.ts';

const shell =
  '<!doctype html><link rel="stylesheet" href="/assets/app.css"><meta name="mehfil-room-id" content="__MEHFIL_ROOM_ID__"><script type="module" src="/assets/app.js"></script>';

const assets = (body = shell, status = 200) => ({
  fetch: () => Promise.resolve(new Response(body, { status })),
});

const directory: RoomDirectory = {
  initialize: () => Promise.resolve(true),
  connect: () => Promise.resolve(new Response('socket')),
};

describe('listener shell', () => {
  test('injects one validated room marker without executable inline code', async () => {
    const html = await roomPage('ABCDEFGH', assets());
    expect(html).toContain('content="ABCDEFGH"');
    expect(html).not.toContain('__MEHFIL_ROOM_ID__');
    expect(html).toContain('src="/assets/app.js"');
  });

  test('rejects invalid room IDs and missing or duplicate markers', async () => {
    await expect(roomPage('BAD<script>', assets())).rejects.toThrow(
      'Invalid room code',
    );
    await expect(roomPage('ABCDEFGH', assets('<html></html>'))).rejects.toThrow(
      'found 0',
    );
    await expect(
      roomPage('ABCDEFGH', assets(`${shell}${shell}`)),
    ).rejects.toThrow('found 2');
  });

  test('serves GET and HEAD with a strict external-assets CSP', async () => {
    const route = createRoomRouter({
      directory,
      renderPage: (roomId) => roomPage(roomId, assets()),
    });
    const get = await route(new Request('https://rooms.test/r/ABCDEFGH'));
    expect(get?.status).toBe(200);
    expect(get?.headers.get('content-security-policy')).toBe(
      "default-src 'none'; connect-src 'self'; media-src 'self' blob:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    const head = await route(
      new Request('https://rooms.test/r/ABCDEFGH', { method: 'HEAD' }),
    );
    expect(await head?.text()).toBe('');
  });

  test('fails closed when the generated asset is unavailable', async () => {
    const route = createRoomRouter({
      directory,
      renderPage: (roomId) => roomPage(roomId, assets('missing', 404)),
    });
    const response = await route(new Request('https://rooms.test/r/ABCDEFGH'));
    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe('Listener assets are unavailable.');
  });
});
