import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { extname, resolve } from 'node:path';

import { roomPage } from '../../src/worker/room-page.ts';
import { createServer } from '../../src/server/index.ts';

const portFlag = process.argv.indexOf('--port');
const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : 4387);
const generatedAudio = '49443304000000000000';
const jobRecords = new Map<string, Record<string, unknown>>();

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Fixture expected a JSON body');
  return body;
}

function fakeFetchResponse(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  );
  if (url.pathname === '/v1/music_generation') {
    const body = JSON.parse(requestBody(init?.body)) as { jobId?: string };
    return json({
      jobId: body.jobId,
      data: { audio: generatedAudio },
      share_ref: body.jobId,
    });
  }
  if (url.pathname === '/rooms') {
    return json(
      {
        roomId: 'ABCDEFGH',
        joinUrl: 'https://rooms.example.test/r/ABCDEFGH',
        socketUrl: 'wss://rooms.example.test/rooms/ABCDEFGH/ws',
        hostSecret: 'A'.repeat(43),
        expiresAt: Date.now() + 60_000,
      },
      201,
    );
  }
  const job = /^\/generation-jobs\/([A-Za-z0-9_-]{24})(?:\/claim)?$/.exec(
    url.pathname,
  );
  if (job) {
    const jobId = job[1] as string;
    if (init?.method === 'POST') {
      const record = { jobId, status: 'pending', createdAt: Date.now() };
      jobRecords.set(jobId, record);
      return json(record, 201);
    }
    if (init?.method === 'PUT') {
      const update = JSON.parse(requestBody(init.body)) as Record<
        string,
        unknown
      >;
      const record = { jobId, ...update };
      jobRecords.set(jobId, record);
      return json(record);
    }
    const record = jobRecords.get(jobId);
    return record ? json(record) : json({ error: 'missing' }, 404);
  }
  if (url.hostname === 'audio.example.test') {
    return new Response(new Uint8Array([73, 68, 51]), {
      headers: { 'content-type': 'audio/mpeg' },
    });
  }
  return json({ error: 'Unexpected fixture request' }, 500);
}

const fakeFetch: typeof fetch = (input, init) =>
  Promise.resolve(fakeFetchResponse(input, init));

const app = createServer({
  apiBase: 'https://api.example.test',
  fetchImpl: fakeFetch,
  writeLyrics: ({ idea }) => ({
    title: idea,
    language: 'Hindi',
    nativeScriptName: 'Devanagari',
    isLatinScript: false,
    lyricsNative: '[Verse]\nबारिश की रात',
    lyricsRoman: '[Verse]\nBaarish ki raat',
    prompt: 'Warm acoustic mehfil',
    languageCode: 'hi',
    usage: null,
  }),
  shareBaseUrl: 'https://rooms.example.test',
  publicBaseUrl: 'https://public.example.test',
  shareSecret: 'fixture-secret',
  staticRoot: resolve('public'),
});
const appHandler = app.listeners('request')[0];
if (typeof appHandler !== 'function')
  throw new Error('Fixture app has no handler');

const listenerRoot = resolve('dist/listener');
const listenerAsset = {
  async fetch(assetRequest: Request) {
    const pathname = new URL(assetRequest.url).pathname;
    try {
      return new Response(
        await readFile(resolve(listenerRoot, pathname.slice(1))),
      );
    } catch {
      return new Response('missing', { status: 404 });
    }
  },
};

const handleRequest = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
) => {
  const pathname = new URL(request.url ?? '/', 'http://fixture').pathname;
  if (pathname.startsWith('/assets/')) {
    try {
      const body = await readFile(resolve(listenerRoot, pathname.slice(1)));
      const type =
        extname(pathname) === '.css' ? 'text/css' : 'text/javascript';
      response.writeHead(200, { 'content-type': type });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
    return;
  }
  const roomMatch = /^\/r\/([A-Z2-9]{8})$/.exec(pathname);
  if (roomMatch) {
    const html = await roomPage(roomMatch[1] as string, listenerAsset);
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; connect-src 'self'; media-src 'self' blob:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    response.end(html);
    return;
  }
  appHandler.call(app, request, response);
};

const server = http.createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Browser fixture listening on ${port}\n`);
});

const close = () => server.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
