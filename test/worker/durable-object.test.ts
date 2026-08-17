import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from 'cloudflare:test';
import { expect, test } from 'vitest';

test('the default Worker and named Durable Object load with local bindings', async () => {
  const missing = await SELF.fetch('https://worker.test/not-found');
  expect(missing.status).toBe(404);

  const id = env.ROOMS.idFromName('ABCDEFGH');
  const stub = env.ROOMS.get(id);
  const openedAt = Date.now();
  const initialized = await stub.fetch('https://room.internal/initialize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomId: 'ABCDEFGH',
      hostDigest: 'fixture-digest',
      openedAt,
      expiresAt: openedAt + 60_000,
    }),
  });
  expect(initialized.status).toBe(201);
  const duplicate = await stub.fetch('https://room.internal/initialize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomId: 'ABCDEFGH',
      hostDigest: 'different-digest',
      openedAt,
      expiresAt: openedAt + 60_000,
    }),
  });
  expect(duplicate.status).toBe(409);
  await expect(
    runInDurableObject(stub, async (_instance, state) =>
      state.storage.get('state'),
    ),
  ).resolves.toMatchObject({ roomId: 'ABCDEFGH', version: 1 });
  const upgrade = await SELF.fetch('https://worker.test/rooms/ABCDEFGH/ws', {
    headers: { upgrade: 'websocket' },
  });
  expect(upgrade.status).toBe(101);
  expect(upgrade.webSocket).toBeTruthy();
  upgrade.webSocket?.accept();
  upgrade.webSocket?.close(1000, 'fixture complete');
  await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
});
