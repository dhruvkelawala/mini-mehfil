import { describe, expect, test, vi } from 'vitest';

import {
  createShareHandler,
  type ShareStorage,
} from '../../src/worker/sharing.ts';

function storage(): ShareStorage {
  return {
    put: vi.fn(() => Promise.resolve()),
    getMetadata: vi.fn(() => Promise.resolve(null)),
    getAudio: vi.fn(() => Promise.resolve(null)),
    claimJob: vi.fn(() => Promise.resolve({ created: true })),
    getJob: vi.fn(() => Promise.resolve(null)),
    transitionJob: vi.fn(() => Promise.resolve({ record: null })),
  };
}

describe('sharing Worker', () => {
  test('keeps unknown routes private', async () => {
    const response = await createShareHandler({ storage: storage() })(
      new Request('https://share.test/private'),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found.' });
  });

  test('requires the upload bearer secret', async () => {
    const response = await createShareHandler({
      storage: storage(),
      uploadSecret: 'worker-secret',
    })(new Request('https://share.test/shares', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  test('claims a versioned recovery job once', async () => {
    const claimJob = vi.fn<ShareStorage['claimJob']>((_id, record) =>
      Promise.resolve({ created: true, record }),
    );
    const store = { ...storage(), claimJob };
    const handler = createShareHandler({
      storage: store,
      uploadSecret: 'worker-secret',
    });
    const response = await handler(
      new Request(
        'https://share.test/generation-jobs/AbCdEfGhIjKlMnOpQrStUvWx/claim',
        { method: 'POST', headers: { authorization: 'Bearer worker-secret' } },
      ),
    );
    expect(response.status).toBe(201);
    expect(claimJob).toHaveBeenCalledOnce();
  });

  test('rate limits authenticated share uploads before accepting bytes', async () => {
    const handler = createShareHandler({
      storage: storage(),
      uploadSecret: 'worker-secret',
      rateLimit: () => Promise.resolve(false),
    });
    const response = await handler(
      new Request('https://share.test/shares', {
        method: 'POST',
        headers: {
          authorization: 'Bearer worker-secret',
          'idempotency-key': 'AbCdEfGhIjKlMnOpQrStUvWx',
        },
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
  });
});
