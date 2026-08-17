import { expect, test } from 'vitest';

import type { ShareStorage } from '../../src/worker/sharing.ts';
import { createShareHandler } from '../../src/worker/sharing.ts';
import type { RoomDirectory } from '../../src/worker/rooms.ts';
import { createRoomRouter } from '../../src/worker/rooms.ts';

function emptyStorage(): ShareStorage {
  return {
    put: () => Promise.resolve(),
    getMetadata: () => Promise.resolve(null),
    getAudio: () => Promise.resolve(null),
    claimJob: () => Promise.resolve({ created: false }),
    getJob: () => Promise.resolve(null),
    transitionJob: () => Promise.resolve({ conflict: true }),
  };
}

test('share handler keeps unknown routes private', async () => {
  const handle = createShareHandler({ storage: emptyStorage() });
  const response = await handle(new Request('https://example.test/not-found'));
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({ error: 'Not found.' });
});

test('room router delegates a valid socket upgrade to the directory', async () => {
  const connected: string[] = [];
  const directory: RoomDirectory = {
    initialize: () => Promise.resolve(true),
    connect(roomId) {
      connected.push(roomId);
      return Promise.resolve(new Response('socket'));
    },
  };
  const route = createRoomRouter({ directory });
  const response = await route(
    new Request('https://example.test/rooms/ABCDEFGH/ws'),
  );
  expect(await response?.text()).toBe('socket');
  expect(connected).toEqual(['ABCDEFGH']);
});
