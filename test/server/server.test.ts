import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import server, {
  assertHostBuild,
  createServer,
  type ServerFetch,
  type ServerOptions,
} from '../../src/server/index.ts';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function staticRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mini-mehfil-test-'));
  temporaryDirectories.push(directory);
  writeFileSync(
    join(directory, 'index.html'),
    '<!doctype html><h1>महफ़िल</h1>',
  );
  return directory;
}

async function withServer(
  run: (base: string) => Promise<void>,
  options: ServerOptions = {},
): Promise<void> {
  const instance = createServer({ staticRoot: staticRoot(), ...options });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  const address = instance.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
}

async function body(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

describe('typed Node server', () => {
  test('exports an HTTP server and clear missing-build assertion', () => {
    expect(typeof server.emit).toBe('function');
    expect(() => assertHostBuild('/definitely/missing/mini-mehfil')).toThrow(
      /build:host/,
    );
  });

  test('serves the built host with privacy headers and root query support', async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/?mediaDebug=1`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('महफ़िल');
      expect(response.headers.get('content-security-policy')).toContain(
        "default-src 'self'",
      );
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });
  });

  test('validates requests before contacting MiniMax', async () => {
    let contacted = false;
    const fetchImpl: ServerFetch = () => {
      contacted = true;
      return Promise.resolve(Response.json({}));
    };
    await withServer(
      async (base) => {
        const response = await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lyrics: 'hello' }),
        });
        expect(response.status).toBe(400);
        expect((await body(response)).error).toBe(
          'Add your MiniMax API token.',
        );
        expect(contacted).toBe(false);
      },
      { fetchImpl },
    );
  });

  test('sends the normalized Music 3 request without leaking the token', async () => {
    let authorization = '';
    let requestBody: Record<string, unknown> = {};
    const fetchImpl: ServerFetch = (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      if (typeof init?.body !== 'string')
        throw new Error('Expected JSON request body');
      const parsed: unknown = JSON.parse(init.body);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      )
        requestBody = parsed as Record<string, unknown>;
      return Promise.resolve(
        Response.json({ data: { audio: 'https://cdn.example/song.mp3' } }),
      );
    };
    await withServer(
      async (base) => {
        const response = await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: 'sk-secret',
            lyrics: '[Verse]\nhello',
            prompt: 'warm',
          }),
        });
        expect(response.status).toBe(200);
      },
      { fetchImpl, apiBase: 'https://mock.minimax.test' },
    );
    expect(authorization).toBe('Bearer sk-secret');
    expect(requestBody.model).toBe('music-3.0');
    expect(JSON.stringify(requestBody)).not.toContain('sk-secret');
  });

  test('uses the injected lyricist and never stores its token', async () => {
    await withServer(
      async (base) => {
        const response = await fetch(`${base}/api/write-lyrics`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'secret', idea: 'rain' }),
        });
        expect(response.status).toBe(200);
        expect((await body(response)).title).toBe('Rain');
      },
      {
        writeLyrics: () => ({
          title: 'Rain',
          language: 'Hindi',
          languageCode: 'hi',
          nativeScriptName: 'Devanagari',
          isLatinScript: false,
          lyricsNative: 'बारिश',
          lyricsRoman: 'baarish',
          prompt: 'warm',
          usage: null,
        }),
      },
    );
  });

  test('proxies a validated room and preserves the Worker URLs', async () => {
    const fetchImpl: ServerFetch = () =>
      Promise.resolve(
        Response.json(
          {
            roomId: 'ABCDEFGH',
            joinUrl: 'https://rooms.example/r/ABCDEFGH',
            socketUrl: 'wss://rooms.example/rooms/ABCDEFGH/ws',
            hostSecret: 'A'.repeat(43),
            expiresAt: Date.now() + 60_000,
          },
          { status: 201 },
        ),
      );
    await withServer(
      async (base) => {
        const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
        expect(response.status).toBe(201);
        expect((await body(response)).roomId).toBe('ABCDEFGH');
      },
      {
        fetchImpl,
        shareBaseUrl: 'https://rooms.example',
        shareSecret: 'worker-secret',
      },
    );
  });
});
