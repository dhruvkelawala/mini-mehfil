import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { test } from 'vitest';

import type { writeLyrics as writeLyricsFunction } from '../../src/server/lyricist.ts';
import { writeLyrics } from '../../src/server/lyricist.ts';
import {
  isNumber,
  isRecord,
  isString,
  type JsonRecord,
  type JsonValue,
} from '../../src/room/primitives.ts';

type WriteLyrics = typeof writeLyricsFunction;
type CapturedRequest = {
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: JsonRecord;
};

// The lyricist reads its API base from the environment at import time, so the mock
// must be listening and exported before the module loads.
async function withMockAnthropic(
  handler: (response: http.ServerResponse) => void,
  run: (writeLyrics: WriteLyrics, requests: CapturedRequest[]) => Promise<void>,
) {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      const parsed: JsonValue | undefined = JSON.parse(body);
      const record = isRecord(parsed) ? parsed : null;
      assert.ok(record);
      requests.push({
        url: req.url,
        headers: req.headers,
        body: record,
      });
      handler(res);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  // SAFETY: the server is listening on a TCP socket, so address() returns an
  // AddressInfo object (never a pipe path or null).
  const address = server.address() as AddressInfo;
  process.env.MINIMAX_ANTHROPIC_BASE = `http://127.0.0.1:${address.port}`;
  try {
    await run(writeLyrics, requests);
  } finally {
    delete process.env.MINIMAX_ANTHROPIC_BASE;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const SHEET = {
  title: 'Aloopuri Khavsa',
  language: 'Gujarati',
  languageCode: 'gu',
  nativeScriptName: 'Gujarati',
  isLatinScript: false,
  lyricsNative: '[Verse]\nઆ સાંજ ધીમે',
  lyricsRoman: '[Verse]\naa saanj dhime',
  prompt: 'Gujarati hip hop, upbeat, brass, male vocal, native pronunciation.',
};

test('speaks the Anthropic Messages protocol the way pi-ai did', async () => {
  await withMockAnthropic(
    (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [
            { type: 'thinking', thinking: 'hmm' },
            {
              type: 'text',
              text: '```json\n' + JSON.stringify(SHEET) + '\n```',
            },
          ],
          usage: { input_tokens: 900, output_tokens: 400 },
        }),
      );
    },
    async (writeLyrics, requests) => {
      const result = await writeLyrics({
        token: 'sk-test',
        idea: 'Aloopuri Khavsa',
        vibe: 'hip hop',
      });
      const req = requests[0];
      assert.ok(req);
      assert.equal(req.url, '/v1/messages');
      assert.equal(req.headers['x-api-key'], 'sk-test');
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
      assert.equal(req.body.model, 'MiniMax-M3');
      assert.ok(isNumber(req.body.max_tokens));
      const system = req.body.system;
      if (!isString(system)) throw new Error('Missing system prompt');
      assert.match(system, /songwriter/);
      // Thinking blocks are ignored, the fenced JSON is parsed, both scripts survive.
      assert.equal(result.language, 'Gujarati');
      assert.match(result.lyricsNative, /સાંજ/);
      assert.match(result.lyricsRoman, /saanj/);
      assert.ok(isRecord(result.usage));
      assert.equal(isRecord(result.usage) && result.usage.output_tokens, 400);
    },
  );
});

test('surfaces an upstream auth error with its real message', async () => {
  await withMockAnthropic(
    (res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    },
    async (writeLyrics) => {
      await assert.rejects(
        () => writeLyrics({ token: 'sk-bad', idea: 'anything' }),
        (error) =>
          error instanceof Error &&
          'status' in error &&
          error.status === 401 &&
          /invalid api key/.test(error.message),
      );
    },
  );
});

test('rejects an empty reply as unreadable rather than crashing', async () => {
  await withMockAnthropic(
    (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: 'sorry, no song today' }],
        }),
      );
    },
    async (writeLyrics) => {
      await assert.rejects(
        () => writeLyrics({ token: 'sk-test', idea: 'anything' }),
        /could not read/i,
      );
    },
  );
});
