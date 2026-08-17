import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABSOLUTE_ROOM_MS,
  AUTH_TIMEOUT_MS,
  EMPTY_GRACE_MS,
  createRoomTransport,
  sha256
} from '../share/room-transport.mjs';

function createHarness() {
  const stored = new Map();
  const delivered = [];
  const closed = [];
  const alarms = [];
  const sessions = new Map();
  let clock = 1_000;
  let sequence = 0;

  const storage = {
    async get(key) {
      return structuredClone(stored.get(key));
    },
    async put(key, value) {
      stored.set(key, structuredClone(value));
    },
    async setAlarm(timestamp) {
      alarms.push(timestamp);
    }
  };

  const connections = {
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
    }
  };

  const transport = createRoomTransport({
    storage,
    connections,
    now: () => clock,
    createParticipantId: () => `id${++sequence}`,
    createResumeCredential: () => `resume${sequence}`
  });

  const messagesFor = socket => delivered
    .filter(item => item.socket === socket)
    .map(item => item.message);
  const latest = (socket, type) => messagesFor(socket)
    .findLast(message => message.type === type);

  return {
    transport,
    closed,
    alarms,
    messagesFor,
    latest,
    tick(milliseconds) {
      clock += milliseconds;
    },
    now() {
      return clock;
    }
  };
}

async function openRoom(harness, options = {}) {
  await harness.transport.initialize({
    roomId: 'ABCDEFGH',
    hostDigest: await sha256('host'),
    ...options
  });
}

async function connectHost(harness, socket = {}) {
  await harness.transport.connect(socket);
  await harness.transport.message(socket, JSON.stringify({
    type: 'auth-host',
    secret: 'host'
  }));
  return socket;
}

async function connectListener(harness, socket = {}, join = { name: 'Ada' }) {
  await harness.transport.connect(socket);
  await harness.transport.message(socket, JSON.stringify({ type: 'join', ...join }));
  return socket;
}

test('host authentication rejects the wrong secret', async () => {
  const harness = createHarness();
  await openRoom(harness);
  const host = {};
  await harness.transport.connect(host);
  await harness.transport.message(host, JSON.stringify({
    type: 'auth-host',
    secret: 'wrong'
  }));

  assert.deepEqual(harness.latest(host, 'error'), {
    type: 'error',
    code: 'auth-failed'
  });
  assert.deepEqual(harness.closed.at(-1), {
    socket: host,
    code: 4001,
    reason: 'auth-failed'
  });
});

test('a listener resumes the same seat after reconnecting', async () => {
  const harness = createHarness();
  await openRoom(harness);
  const firstConnection = await connectListener(harness);
  const credential = harness.latest(firstConnection, 'resume-credential').credential;

  await harness.transport.message(firstConnection, JSON.stringify({
    type: 'request-submitted',
    idea: 'rain'
  }));
  await harness.transport.disconnect(firstConnection);

  const resumedConnection = await connectListener(
    harness,
    {},
    { resume: credential }
  );
  const snapshot = harness.latest(resumedConnection, 'snapshot').state;

  assert.equal(snapshot.listenerCount, 1);
  assert.deepEqual(snapshot.queue, [{ id: 'id2', status: 'pending', mine: true }]);
});

test('an unauthenticated socket is closed after the authentication timeout', async () => {
  const harness = createHarness();
  await openRoom(harness);
  const socket = {};
  await harness.transport.connect(socket);
  harness.tick(AUTH_TIMEOUT_MS);
  harness.transport.checkAuthenticationTimeout(socket);

  assert.equal(harness.closed.at(-1).reason, 'authentication-timeout');
});

test('malformed, oversized, and pre-authentication messages stay private', async () => {
  const harness = createHarness();
  await openRoom(harness);
  const socket = {};
  await harness.transport.connect(socket);

  await harness.transport.message(socket, '{');
  await harness.transport.message(socket, 'x'.repeat(17_000));
  await harness.transport.message(socket, JSON.stringify({
    type: 'request-submitted',
    idea: 'rain'
  }));

  assert.deepEqual(
    harness.messagesFor(socket).map(message => message.code),
    ['invalid-message', 'invalid-message', 'authenticate-first']
  );
});

test('listener messages cannot spoof their role or identity', async () => {
  const harness = createHarness();
  await openRoom(harness);
  const listener = await connectListener(harness);

  await harness.transport.message(listener, JSON.stringify({
    type: 'request-submitted',
    role: 'host',
    actorId: 'evil',
    participantId: 'evil',
    idea: 'rain'
  }));

  const host = await connectHost(harness);
  const snapshot = harness.latest(host, 'snapshot').state;
  assert.equal(snapshot.queue[0].participantId, snapshot.participants[0].id);
});

test('a rejected action is sent only to the caller', async () => {
  const harness = createHarness();
  await openRoom(harness);
  const listener = await connectListener(harness);
  const host = await connectHost(harness);
  const hostMessageCount = harness.messagesFor(host).length;

  await harness.transport.message(listener, JSON.stringify({
    type: 'request-accepted',
    requestId: 'missing'
  }));

  assert.equal(harness.latest(listener, 'error').code, 'host-only');
  assert.equal(harness.messagesFor(host).length, hostMessageCount);
});

test('kick closes the listener and invalidates its resume credential', async () => {
  const harness = createHarness();
  await openRoom(harness);
  const listener = await connectListener(harness);
  const credential = harness.latest(listener, 'resume-credential').credential;
  const host = await connectHost(harness);
  const participantId = harness.latest(host, 'snapshot').state.participants[0].id;

  await harness.transport.message(host, JSON.stringify({
    type: 'kicked',
    participantId
  }));
  const reconnect = await connectListener(harness, {}, { resume: credential });

  assert.ok(harness.closed.some(item => item.socket === listener && item.code === 4003));
  assert.equal(harness.latest(reconnect, 'error').code, 'resume-invalid');
});

test('a listener cannot revoke a credential by spoofing a kick', async () => {
  const harness = createHarness();
  await openRoom(harness);
  const listener = await connectListener(harness);
  const credential = harness.latest(listener, 'resume-credential').credential;

  await harness.transport.message(listener, JSON.stringify({
    type: 'kicked',
    role: 'host',
    participantId: 'id1'
  }));
  await harness.transport.disconnect(listener);
  const resumed = await connectListener(harness, {}, { resume: credential });

  assert.equal(harness.latest(resumed, 'snapshot').state.listenerCount, 1);
});

test('an empty room accepts reconnects during grace and expires afterward', async () => {
  const harness = createHarness();
  await openRoom(harness);
  const listener = await connectListener(harness);
  const credential = harness.latest(listener, 'resume-credential').credential;
  await harness.transport.disconnect(listener);

  harness.tick(EMPTY_GRACE_MS - 1);
  await harness.transport.alarm();
  const duringGrace = await connectListener(harness, {}, { resume: credential });
  assert.equal(harness.latest(duringGrace, 'snapshot').state.expiredAt, null);

  await harness.transport.disconnect(duringGrace);
  harness.tick(EMPTY_GRACE_MS);
  await harness.transport.alarm();
  const afterGrace = {};
  assert.equal(await harness.transport.connect(afterGrace), false);
  assert.equal(harness.closed.at(-1).reason, 'room-unavailable');
});

test('the absolute room cap expires a room even with listeners present', async () => {
  const harness = createHarness();
  await openRoom(harness, { expiresAt: 2_000 });
  const listener = await connectListener(harness);
  harness.tick(1_000);
  await harness.transport.alarm();

  assert.equal(harness.latest(listener, 'snapshot').state.expiredAt, 2_000);
  assert.ok(harness.closed.some(item => item.socket === listener && item.code === 4004));
});

test('uninitialized and already-expired rooms close without authenticating', async () => {
  const emptyHarness = createHarness();
  const probe = {};
  assert.equal(await emptyHarness.transport.connect(probe), false);

  const expiredHarness = createHarness();
  await openRoom(expiredHarness, { expiresAt: expiredHarness.now() });
  const expiredProbe = {};
  assert.equal(await expiredHarness.transport.connect(expiredProbe), false);

  assert.equal(emptyHarness.closed.at(-1).reason, 'room-unavailable');
  assert.equal(expiredHarness.closed.at(-1).reason, 'room-unavailable');
});

test('the room cap rejects the twenty-first listener', async () => {
  const harness = createHarness();
  await openRoom(harness, { expiresAt: harness.now() + ABSOLUTE_ROOM_MS });

  for (let index = 0; index < 20; index += 1) {
    await connectListener(harness, {}, { name: `Listener ${index + 1}` });
  }
  const rejected = await connectListener(harness);

  assert.equal(harness.latest(rejected, 'error').code, 'room-full');
  assert.ok(harness.closed.some(item => item.socket === rejected && item.code === 4002));
});

test('host playback commands are scheduled and broadcast while listener commands are rejected', async () => {
  const harness = createHarness();
  await openRoom(harness);
  const listener = await connectListener(harness);
  const host = await connectHost(harness);

  await harness.transport.message(listener, JSON.stringify({
    type: 'request-submitted',
    idea: 'rain'
  }));
  const requestId = harness.latest(host, 'snapshot').state.queue[0].id;
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
        lyricsRoman: 'baarish'
      }
    },
    { type: 'song-ready', requestId, shareId: 'abcdefghijklmnop' }
  ]) {
    await harness.transport.message(host, JSON.stringify(message));
  }

  await harness.transport.message(host, JSON.stringify({
    type: 'playback-updated',
    shareId: 'abcdefghijklmnop',
    status: 'playing',
    positionMs: 750
  }));
  assert.deepEqual(harness.latest(listener, 'snapshot').state.currentSong.playback, {
    status: 'playing',
    positionMs: 750,
    changedAt: harness.now() + 1_500
  });

  await harness.transport.message(listener, JSON.stringify({
    type: 'playback-updated',
    shareId: 'abcdefghijklmnop',
    status: 'paused',
    positionMs: 900
  }));
  assert.equal(harness.latest(listener, 'error').code, 'host-only');
  assert.equal(harness.latest(host, 'snapshot').state.currentSong.playback.status, 'playing');
});

test('a host standalone generation becomes the listener current song', async () => {
  const harness = createHarness();
  await openRoom(harness);
  const listener = await connectListener(harness);
  const host = await connectHost(harness);

  await harness.transport.message(host, JSON.stringify({
    type: 'song-shared',
    shareId: 'abcdefghijklmnop',
    lyrics: {
      title: 'Body on Fire',
      language: 'English',
      nativeScriptName: 'Latin',
      isLatinScript: true,
      lyricsNative: 'Sun came in',
      lyricsRoman: 'Sun came in'
    }
  }));

  const song = harness.latest(listener, 'snapshot').state.currentSong;
  assert.equal(song.shareId, 'abcdefghijklmnop');
  assert.equal(song.title, 'Body on Fire');
  assert.deepEqual(song.playback, {
    status: 'paused',
    positionMs: 0,
    changedAt: harness.now()
  });
});
