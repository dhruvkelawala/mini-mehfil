import { describe, expect, test } from 'vitest';

import { isRecord } from '../../src/room/protocol.ts';
import type { RoomSession } from '../../src/room/protocol.ts';
import type { RoomConnections, RoomStorage } from '../../src/room/transport.ts';
import {
  ABSOLUTE_ROOM_MS,
  AUTH_TIMEOUT_MS,
  createRoomTransport,
  EMPTY_GRACE_MS,
  sha256,
} from '../../src/room/transport.ts';

interface Socket {
  id: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected an object');
  return value;
}

function stringField(value: unknown, key: string): string {
  const field = record(value)[key];
  if (typeof field !== 'string')
    throw new Error(`Expected ${key} to be a string`);
  return field;
}

function arrayField(value: unknown, key: string): unknown[] {
  const field = record(value)[key];
  if (!Array.isArray(field)) throw new Error(`Expected ${key} to be an array`);
  return field;
}

function createHarness() {
  const stored = new Map<'state' | 'meta', unknown>();
  const delivered: Array<{ socket: Socket; message: unknown }> = [];
  const closed: Array<{
    socket: Socket;
    code: number;
    reason: string;
  }> = [];
  const alarms: number[] = [];
  const sessions = new Map<Socket, RoomSession>();
  let clock = 1_000;
  let sequence = 0;

  const storage: RoomStorage = {
    get(key) {
      return Promise.resolve(structuredClone(stored.get(key)));
    },
    put(key, value) {
      stored.set(key, structuredClone(value));
      return Promise.resolve();
    },
    setAlarm(timestamp) {
      alarms.push(timestamp);
      return Promise.resolve();
    },
  };
  const connections: RoomConnections<Socket> = {
    send(socket, message) {
      delivered.push({ socket, message });
    },
    broadcast(createMessage) {
      for (const [socket, session] of sessions) {
        if (session.authenticated) {
          delivered.push({ socket, message: createMessage(socket) });
        }
      }
    },
    close(socket, code, reason) {
      closed.push({ socket, code, reason });
    },
    setSession(socket, session) {
      sessions.set(socket, session);
    },
    getSession(socket) {
      return sessions.get(socket);
    },
  };
  const transport = createRoomTransport({
    storage,
    connections,
    now: () => clock,
    createParticipantId: () => `id${++sequence}`,
    createResumeCredential: () => `resume${sequence}`,
  });
  const latest = (socket: Socket, type: string): Record<string, unknown> => {
    const message = delivered
      .filter((item) => item.socket === socket)
      .map((item) => item.message)
      .findLast((item) => isRecord(item) && item.type === type);
    return record(message);
  };
  const messagesFor = (socket: Socket) =>
    delivered
      .filter((item) => item.socket === socket)
      .map((item) => item.message);
  return {
    transport,
    closed,
    alarms,
    latest,
    messagesFor,
    tick(milliseconds: number) {
      clock += milliseconds;
    },
    now: () => clock,
    socket: (id: string): Socket => ({ id }),
    corrupt(key: 'state' | 'meta', value: unknown) {
      stored.set(key, value);
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

async function openRoom(
  harness: Harness,
  options: { expiresAt?: number } = {},
) {
  await harness.transport.initialize({
    roomId: 'ABCDEFGH',
    hostDigest: await sha256('host'),
    ...options,
  });
}

async function connectHost(harness: Harness, socket = harness.socket('host')) {
  await harness.transport.connect(socket);
  await harness.transport.message(
    socket,
    JSON.stringify({ type: 'auth-host', secret: 'host' }),
  );
  return socket;
}

async function connectListener(
  harness: Harness,
  socket = harness.socket('listener'),
  join: { name?: string; resume?: string } = { name: 'Ada' },
) {
  await harness.transport.connect(socket);
  await harness.transport.message(
    socket,
    JSON.stringify({ type: 'join', ...join }),
  );
  return socket;
}

function snapshot(harness: Harness, socket: Socket): Record<string, unknown> {
  return record(harness.latest(socket, 'snapshot').state);
}

describe('room transport', () => {
  test('host authentication rejects the wrong secret', async () => {
    const harness = createHarness();
    await openRoom(harness);
    const host = harness.socket('host');
    await harness.transport.connect(host);
    await harness.transport.message(
      host,
      JSON.stringify({ type: 'auth-host', secret: 'wrong' }),
    );
    expect(harness.latest(host, 'error')).toEqual({
      type: 'error',
      code: 'auth-failed',
    });
    expect(harness.closed.at(-1)).toEqual({
      socket: host,
      code: 4001,
      reason: 'auth-failed',
    });
  });

  test('a listener resumes the same seat after reconnecting', async () => {
    const harness = createHarness();
    await openRoom(harness);
    const first = await connectListener(harness);
    const credential = stringField(
      harness.latest(first, 'resume-credential'),
      'credential',
    );
    await harness.transport.message(
      first,
      JSON.stringify({ type: 'request-submitted', idea: 'rain' }),
    );
    await harness.transport.disconnect(first);
    const resumed = await connectListener(harness, harness.socket('resumed'), {
      resume: credential,
    });
    expect(snapshot(harness, resumed).listenerCount).toBe(1);
    expect(arrayField(snapshot(harness, resumed), 'queue')).toEqual([
      { id: 'id2', status: 'pending', mine: true },
    ]);
  });

  test('an unauthenticated socket closes after the authentication timeout', async () => {
    const harness = createHarness();
    await openRoom(harness);
    const socket = harness.socket('probe');
    await harness.transport.connect(socket);
    harness.tick(AUTH_TIMEOUT_MS);
    harness.transport.checkAuthenticationTimeout(socket);
    expect(harness.closed.at(-1)?.reason).toBe('authentication-timeout');
  });

  test('malformed, oversized, and pre-authentication messages stay private', async () => {
    const harness = createHarness();
    await openRoom(harness);
    const socket = harness.socket('probe');
    await harness.transport.connect(socket);
    await harness.transport.message(socket, '{');
    await harness.transport.message(socket, 'x'.repeat(17_000));
    await harness.transport.message(
      socket,
      JSON.stringify({ type: 'request-submitted', idea: 'rain' }),
    );
    expect(
      harness.messagesFor(socket).map((message) => record(message).code),
    ).toEqual(['invalid-message', 'invalid-message', 'authenticate-first']);
  });

  test('listener messages cannot spoof their role or identity', async () => {
    const harness = createHarness();
    await openRoom(harness);
    const listener = await connectListener(harness);
    await harness.transport.message(
      listener,
      JSON.stringify({
        type: 'request-submitted',
        role: 'host',
        actorId: 'evil',
        participantId: 'evil',
        idea: 'rain',
      }),
    );
    const host = await connectHost(harness);
    const hostState = snapshot(harness, host);
    const queued = record(arrayField(hostState, 'queue')[0]);
    const participant = record(arrayField(hostState, 'participants')[0]);
    expect(queued.participantId).toBe(participant.id);
  });

  test('a rejected action is sent only to the caller', async () => {
    const harness = createHarness();
    await openRoom(harness);
    const listener = await connectListener(harness);
    const host = await connectHost(harness);
    const hostMessageCount = harness.messagesFor(host).length;
    await harness.transport.message(
      listener,
      JSON.stringify({ type: 'request-accepted', requestId: 'missing' }),
    );
    expect(harness.latest(listener, 'error').code).toBe('host-only');
    expect(harness.messagesFor(host)).toHaveLength(hostMessageCount);
  });

  test('kick closes the listener and invalidates its resume credential', async () => {
    const harness = createHarness();
    await openRoom(harness);
    const listener = await connectListener(harness);
    const credential = stringField(
      harness.latest(listener, 'resume-credential'),
      'credential',
    );
    const host = await connectHost(harness);
    const participantId = stringField(
      arrayField(snapshot(harness, host), 'participants')[0],
      'id',
    );
    await harness.transport.message(
      host,
      JSON.stringify({ type: 'kicked', participantId }),
    );
    const reconnect = await connectListener(
      harness,
      harness.socket('reconnect'),
      { resume: credential },
    );
    expect(
      harness.closed.some(
        (item) => item.socket === listener && item.code === 4003,
      ),
    ).toBe(true);
    expect(harness.latest(reconnect, 'error').code).toBe('resume-invalid');
  });

  test('a listener cannot revoke a credential by spoofing a kick', async () => {
    const harness = createHarness();
    await openRoom(harness);
    const listener = await connectListener(harness);
    const credential = stringField(
      harness.latest(listener, 'resume-credential'),
      'credential',
    );
    await harness.transport.message(
      listener,
      JSON.stringify({ type: 'kicked', role: 'host', participantId: 'id1' }),
    );
    await harness.transport.disconnect(listener);
    const resumed = await connectListener(harness, harness.socket('resumed'), {
      resume: credential,
    });
    expect(snapshot(harness, resumed).listenerCount).toBe(1);
  });

  test('an empty room accepts reconnects during grace and expires afterward', async () => {
    const harness = createHarness();
    await openRoom(harness);
    const listener = await connectListener(harness);
    const credential = stringField(
      harness.latest(listener, 'resume-credential'),
      'credential',
    );
    await harness.transport.disconnect(listener);
    harness.tick(EMPTY_GRACE_MS - 1);
    await harness.transport.alarm();
    const duringGrace = await connectListener(
      harness,
      harness.socket('during'),
      { resume: credential },
    );
    expect(snapshot(harness, duringGrace).expiredAt).toBeNull();
    await harness.transport.disconnect(duringGrace);
    harness.tick(EMPTY_GRACE_MS);
    await harness.transport.alarm();
    const afterGrace = harness.socket('after');
    await expect(harness.transport.connect(afterGrace)).resolves.toBe(false);
    expect(harness.closed.at(-1)?.reason).toBe('room-unavailable');
  });

  test('the absolute room cap expires with listeners present', async () => {
    const harness = createHarness();
    await openRoom(harness, { expiresAt: 2_000 });
    const listener = await connectListener(harness);
    harness.tick(1_000);
    await harness.transport.alarm();
    expect(snapshot(harness, listener).expiredAt).toBe(2_000);
    expect(
      harness.closed.some(
        (item) => item.socket === listener && item.code === 4004,
      ),
    ).toBe(true);
  });

  test('uninitialized, corrupt, and already-expired rooms close', async () => {
    const empty = createHarness();
    const probe = empty.socket('empty');
    await expect(empty.transport.connect(probe)).resolves.toBe(false);
    expect(empty.closed.at(-1)?.reason).toBe('room-unavailable');

    const corrupt = createHarness();
    corrupt.corrupt('state', { version: 1, participants: 'invalid' });
    corrupt.corrupt('meta', { hostDigest: 3 });
    await expect(
      corrupt.transport.connect(corrupt.socket('corrupt')),
    ).resolves.toBe(false);

    const expired = createHarness();
    await openRoom(expired, { expiresAt: expired.now() });
    await expect(
      expired.transport.connect(expired.socket('expired')),
    ).resolves.toBe(false);
  });

  test('the room cap rejects the twenty-first listener', async () => {
    const harness = createHarness();
    await openRoom(harness, { expiresAt: harness.now() + ABSOLUTE_ROOM_MS });
    for (let index = 0; index < 20; index += 1) {
      await connectListener(harness, harness.socket(`listener-${index}`), {
        name: `Listener ${index + 1}`,
      });
    }
    const rejected = await connectListener(harness, harness.socket('rejected'));
    expect(harness.latest(rejected, 'error').code).toBe('room-full');
    expect(
      harness.closed.some(
        (item) => item.socket === rejected && item.code === 4002,
      ),
    ).toBe(true);
  });

  test('host playback is scheduled while listener playback is rejected', async () => {
    const harness = createHarness();
    await openRoom(harness);
    const listener = await connectListener(harness);
    const host = await connectHost(harness);
    await harness.transport.message(
      listener,
      JSON.stringify({ type: 'request-submitted', idea: 'rain' }),
    );
    const requestId = stringField(
      arrayField(snapshot(harness, host), 'queue')[0],
      'id',
    );
    for (const message of [
      { type: 'request-accepted', requestId },
      { type: 'recording-started', requestId },
      {
        type: 'lyrics-ready',
        requestId,
        lyrics: {
          title: 'Rain',
          language: 'Hindi',
          lyricsNative: 'बारिश',
          lyricsRoman: 'baarish',
        },
      },
      { type: 'song-ready', requestId, shareId: 'abcdefghijklmnop' },
    ]) {
      await harness.transport.message(host, JSON.stringify(message));
    }
    await harness.transport.message(
      host,
      JSON.stringify({
        type: 'playback-updated',
        shareId: 'abcdefghijklmnop',
        status: 'playing',
        positionMs: 750,
      }),
    );
    const currentSong = record(snapshot(harness, listener).currentSong);
    expect(currentSong.playback).toEqual({
      status: 'playing',
      positionMs: 750,
      changedAt: harness.now() + 1_500,
    });
    await harness.transport.message(
      listener,
      JSON.stringify({
        type: 'playback-updated',
        shareId: 'abcdefghijklmnop',
        status: 'paused',
        positionMs: 900,
      }),
    );
    expect(harness.latest(listener, 'error').code).toBe('host-only');
  });

  test('a host standalone generation becomes the listener current song', async () => {
    const harness = createHarness();
    await openRoom(harness);
    const listener = await connectListener(harness);
    const host = await connectHost(harness);
    await harness.transport.message(
      host,
      JSON.stringify({
        type: 'song-shared',
        shareId: 'abcdefghijklmnop',
        lyrics: {
          title: 'Body on Fire',
          language: 'English',
          nativeScriptName: 'Latin',
          isLatinScript: true,
          lyricsNative: 'Sun came in',
          lyricsRoman: 'Sun came in',
        },
      }),
    );
    expect(record(snapshot(harness, listener).currentSong)).toMatchObject({
      shareId: 'abcdefghijklmnop',
      title: 'Body on Fire',
      playback: { status: 'paused', positionMs: 0, changedAt: harness.now() },
    });
  });
});
