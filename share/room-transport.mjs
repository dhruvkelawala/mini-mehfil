import {
  createRoomState,
  projectRoomState,
  transitionRoom
} from './room-state.mjs';

export const MAX_MESSAGE_BYTES = 16 * 1024;
export const AUTH_TIMEOUT_MS = 5_000;
export const ABSOLUTE_ROOM_MS = 6 * 60 * 60 * 1000;
export const EMPTY_GRACE_MS = 15 * 60 * 1000;
export const SONG_START_DELAY_MS = 1_500;

const CLIENT_EVENT_TYPES = new Set([
  'request-submitted',
  'request-accepted',
  'request-reordered',
  'request-declined',
  'recording-started',
  'lyrics-ready',
  'recording-failed',
  'song-ready',
  'song-shared',
  'playback-updated',
  'kicked',
  'room-expired'
]);

export async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function constantTimeEqual(left, right) {
  const first = String(left);
  const second = String(right);
  let difference = first.length ^ second.length;
  const length = Math.max(first.length, second.length);

  for (let index = 0; index < length; index += 1) {
    difference |= (first.charCodeAt(index) || 0) ^ (second.charCodeAt(index) || 0);
  }

  return difference === 0;
}

/**
 * Owns authentication, persistence, projections, expiry, and event dispatch for
 * one room. Callers provide two adapters: durable storage and live connections.
 * Tests exercise the same lifecycle interface used by MehfilRoom.
 */
export function createRoomTransport({
  storage,
  connections,
  now = Date.now,
  createParticipantId,
  createResumeCredential
} = {}) {
  if (!storage || !connections) {
    throw new Error('Room storage and connection adapters are required.');
  }

  const localSockets = new Set();
  const activeSockets = () => connections.list?.() || [...localSockets];
  let state;
  let metadata;

  async function load() {
    state ||= await storage.get('state');
    metadata ||= await storage.get('meta');
  }

  async function persistState(nextState) {
    state = nextState;
    await storage.put('state', nextState);
  }

  function sendError(socket, code) {
    connections.send(socket, { type: 'error', code });
  }

  async function broadcastSnapshots() {
    connections.broadcast(socket => ({
      type: 'snapshot',
      state: projectRoomState(state, connections.getSession(socket) || {})
    }));
  }

  async function scheduleExpiry() {
    const someoneIsPresent = [...activeSockets()].some(
      socket => connections.getSession(socket)?.authenticated
    );

    if (someoneIsPresent) metadata.emptyDeadline = null;
    else metadata.emptyDeadline ||= now() + EMPTY_GRACE_MS;

    await storage.put('meta', metadata);
    await storage.setAlarm(
      Math.min(metadata.absoluteDeadline, metadata.emptyDeadline || Infinity)
    );
  }

  function applyEffects(effects) {
    for (const effect of effects) {
      if (effect.type === 'close-participant') {
        for (const socket of activeSockets()) {
          const session = connections.getSession(socket);
          if (session?.participantId === effect.participantId) {
            connections.close(socket, 4003, 'kicked');
          }
        }
      }

      if (effect.type === 'close-all') {
        for (const socket of activeSockets()) {
          connections.close(socket, 4004, 'expired');
        }
      }
    }
  }

  async function commit(result) {
    await persistState(result.state);
    await broadcastSnapshots();
    applyEffects(result.effects);
  }

  async function apply(socket, event) {
    const result = transitionRoom(state, event);
    if (result.error) {
      if (socket) sendError(socket, result.error.code);
      return false;
    }

    await commit(result);
    return true;
  }

  async function expireIfDue() {
    if (!state || !metadata || state.expiredAt) return;

    const absoluteExpiryReached = now() >= metadata.absoluteDeadline;
    const emptyExpiryReached = metadata.emptyDeadline
      && now() >= metadata.emptyDeadline;

    if (absoluteExpiryReached || emptyExpiryReached) {
      await apply(null, {
        type: 'room-expired',
        role: 'host',
        trustedAlarm: true,
        at: now()
      });
    }
  }

  async function authenticateHost(socket, message) {
    const providedDigest = await sha256(message.secret || '');
    if (!constantTimeEqual(providedDigest, metadata.hostDigest)) {
      sendError(socket, 'auth-failed');
      connections.close(socket, 4001, 'auth-failed');
      return;
    }

    const result = transitionRoom(state, {
      type: 'joined',
      role: 'host',
      participantId: 'host',
      at: now()
    });

    if (result.error) {
      sendError(socket, result.error.code);
      connections.close(socket, 4004, 'room-unavailable');
      return;
    }

    connections.setSession(socket, {
      authenticated: true,
      role: 'host',
      participantId: 'host'
    });
    await commit(result);
    await scheduleExpiry();
  }

  async function findResumedParticipant(credential) {
    const digest = await sha256(credential);
    const participantId = Object.keys(metadata.resumeDigests)
      .find(id => constantTimeEqual(metadata.resumeDigests[id], digest));
    const wasKicked = metadata.kickedDigests
      .some(item => constantTimeEqual(item, digest));
    return wasKicked ? null : participantId;
  }

  async function authenticateListener(socket, message) {
    let participantId;
    let credential;

    if (message.resume) {
      participantId = await findResumedParticipant(message.resume);
      if (!participantId) {
        sendError(socket, 'resume-invalid');
        return;
      }
    } else {
      participantId = createParticipantId();
      credential = createResumeCredential();
    }

    const result = transitionRoom(state, {
      type: 'joined',
      role: 'listener',
      participantId,
      actorId: participantId,
      name: message.name,
      at: now()
    });

    if (result.error) {
      sendError(socket, result.error.code);
      if (result.error.code === 'room-full') {
        connections.close(socket, 4002, 'room-full');
      }
      if (result.error.code === 'room-expired') {
        connections.close(socket, 4004, 'room-unavailable');
      }
      return;
    }

    connections.setSession(socket, {
      authenticated: true,
      role: 'listener',
      participantId
    });
    await commit(result);

    if (credential) {
      metadata.resumeDigests[participantId] = await sha256(credential);
      await storage.put('meta', metadata);
      connections.send(socket, { type: 'resume-credential', credential });
    }

    await scheduleExpiry();
  }

  async function authenticate(socket, message) {
    if (message.type === 'auth-host') {
      await authenticateHost(socket, message);
      return;
    }
    if (message.type === 'join') {
      await authenticateListener(socket, message);
      return;
    }
    sendError(socket, 'authenticate-first');
  }

  function decodeMessage(socket, raw) {
    const isTooLarge = typeof raw !== 'string'
      || new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES;
    if (isTooLarge) {
      sendError(socket, 'invalid-message');
      return null;
    }

    try {
      const message = JSON.parse(raw);
      if (message && typeof message.type === 'string') return message;
    } catch {
      // The caller receives the same private error for all malformed payloads.
    }

    sendError(socket, 'invalid-message');
    return null;
  }

  function eventFromMessage(message, session) {
    const event = {
      ...message,
      role: session.role,
      actorId: session.participantId,
      participantId: message.type === 'request-submitted'
        ? session.participantId
        : message.participantId,
      at: now()
    };

    if (message.type === 'request-submitted') {
      event.requestId = createParticipantId();
    }
    if (message.type === 'song-ready' || message.type === 'song-shared') {
      event.startedAt = now();
    }
    if (message.type === 'playback-updated' && message.status === 'playing') {
      event.at += SONG_START_DELAY_MS;
    }
    return event;
  }

  async function dispatchClientEvent(socket, message, session) {
    if (!CLIENT_EVENT_TYPES.has(message.type)) {
      sendError(socket, 'unknown-message');
      return;
    }

    const kickedDigest = message.type === 'kicked'
      ? metadata.resumeDigests[message.participantId]
      : null;
    const accepted = await apply(socket, eventFromMessage(message, session));

    if (accepted && kickedDigest) {
      metadata.kickedDigests.push(kickedDigest);
      delete metadata.resumeDigests[message.participantId];
      await storage.put('meta', metadata);
    }
  }

  return {
    async initialize({
      roomId,
      hostDigest,
      openedAt = now(),
      expiresAt = openedAt + ABSOLUTE_ROOM_MS
    }) {
      if (await storage.get('state')) return false;

      state = createRoomState({ roomId, openedAt, expiresAt });
      metadata = {
        hostDigest,
        absoluteDeadline: expiresAt,
        emptyDeadline: openedAt + EMPTY_GRACE_MS,
        resumeDigests: {},
        kickedDigests: []
      };

      await storage.put('state', state);
      await storage.put('meta', metadata);
      await storage.setAlarm(Math.min(expiresAt, metadata.emptyDeadline));
      return true;
    },

    async connect(socket) {
      await load();
      localSockets.add(socket);
      await expireIfDue();

      if (!state || !metadata || state.expiredAt) {
        connections.close(socket, 4004, 'room-unavailable');
        return false;
      }

      connections.setSession(socket, {
        authenticated: false,
        connectedAt: now()
      });
      return true;
    },

    async message(socket, raw) {
      await load();
      localSockets.add(socket);
      await expireIfDue();

      if (!state || !metadata || state.expiredAt) {
        connections.close(socket, 4004, 'room-unavailable');
        return;
      }

      const message = decodeMessage(socket, raw);
      if (!message) return;

      const session = connections.getSession(socket) || {};
      if (!session.authenticated) {
        await authenticate(socket, message);
        return;
      }

      await dispatchClientEvent(socket, message, session);
    },

    async disconnect(socket) {
      await load();
      const session = connections.getSession(socket) || {};
      localSockets.delete(socket);
      if (!state || !metadata) return;

      const participantStillConnected = [...activeSockets()].some(candidate => {
        if (candidate === socket) return false;
        const candidateSession = connections.getSession(candidate);
        return candidateSession?.authenticated
          && candidateSession.role === session.role
          && candidateSession.participantId === session.participantId;
      });

      if (session.authenticated && !participantStillConnected) {
        await apply(socket, {
          type: 'left',
          role: session.role,
          participantId: session.participantId,
          actorId: session.participantId,
          at: now()
        });
      }

      await scheduleExpiry();
    },

    checkAuthenticationTimeout(socket) {
      const session = connections.getSession(socket);
      const waited = now() - (session?.connectedAt || 0);
      if (!session?.authenticated && waited >= AUTH_TIMEOUT_MS) {
        connections.close(socket, 4001, 'authentication-timeout');
      }
    },

    async alarm() {
      await load();
      if (!state || !metadata) return;

      const roomIsStillLive = now() < metadata.absoluteDeadline
        && (!metadata.emptyDeadline || now() < metadata.emptyDeadline);
      if (roomIsStillLive) {
        await storage.setAlarm(
          Math.min(metadata.absoluteDeadline, metadata.emptyDeadline || Infinity)
        );
        return;
      }

      await apply(null, {
        type: 'room-expired',
        role: 'host',
        trustedAlarm: true,
        at: now()
      });
    }
  };
}
