import type {
  ClientMessage,
  RoomEvent,
  RoomSession,
  RoomState,
  TransitionResult,
} from './protocol.ts';
import { isRecord, parseClientMessage, parseRoomState } from './protocol.ts';
import { createRoomState, projectRoomState, transitionRoom } from './state.ts';

export const MAX_MESSAGE_BYTES = 16 * 1024;
export const AUTH_TIMEOUT_MS = 5_000;
export const ABSOLUTE_ROOM_MS = 6 * 60 * 60 * 1000;
export const EMPTY_GRACE_MS = 15 * 60 * 1000;
export const SONG_START_DELAY_MS = 1_500;

interface RoomMetadata {
  hostDigest: string;
  absoluteDeadline: number;
  emptyDeadline: number | null;
  resumeDigests: Record<string, string>;
  kickedDigests: string[];
}

export interface RoomStorage {
  get(key: 'state' | 'meta'): Promise<unknown>;
  put(key: 'state' | 'meta', value: RoomState | RoomMetadata): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
}

export interface RoomConnections<Socket> {
  list?(): Iterable<Socket>;
  send(socket: Socket, message: unknown): void;
  broadcast(createMessage: (socket: Socket) => unknown): void;
  close(socket: Socket, code: number, reason: string): void;
  setSession(socket: Socket, session: RoomSession): void;
  getSession(socket: Socket): RoomSession | undefined;
}

export interface RoomTransport<Socket> {
  initialize(options: {
    roomId: string;
    hostDigest: string;
    openedAt?: number;
    expiresAt?: number;
  }): Promise<boolean>;
  connect(socket: Socket): Promise<boolean>;
  message(socket: Socket, raw: unknown): Promise<void>;
  disconnect(socket: Socket): Promise<void>;
  checkAuthenticationTimeout(socket: Socket): void;
  alarm(): Promise<void>;
}

interface RoomTransportOptions<Socket> {
  storage: RoomStorage;
  connections: RoomConnections<Socket>;
  now?: () => number;
  createParticipantId: () => string;
  createResumeCredential: () => string;
}

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(left: unknown, right: unknown): boolean {
  const first = String(left);
  const second = String(right);
  let difference = first.length ^ second.length;
  const length = Math.max(first.length, second.length);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (first.charCodeAt(index) || 0) ^ (second.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return null;
    result[key] = item;
  }
  return result;
}

function parseMetadata(value: unknown): RoomMetadata | null {
  if (!isRecord(value)) return null;
  const resumeDigests = stringRecord(value.resumeDigests);
  if (
    typeof value.hostDigest !== 'string' ||
    typeof value.absoluteDeadline !== 'number' ||
    (value.emptyDeadline !== null && typeof value.emptyDeadline !== 'number') ||
    !resumeDigests ||
    !Array.isArray(value.kickedDigests) ||
    !value.kickedDigests.every((item) => typeof item === 'string')
  ) {
    return null;
  }
  return {
    hostDigest: value.hostDigest,
    absoluteDeadline: value.absoluteDeadline,
    emptyDeadline: value.emptyDeadline,
    resumeDigests,
    kickedDigests: value.kickedDigests,
  };
}

function clientEvent(
  message: Exclude<ClientMessage, { type: 'auth-host' } | { type: 'join' }>,
  session: RoomSession & { role: 'host' | 'listener'; participantId: string },
  at: number,
  createRequestId: () => string,
): RoomEvent {
  const base = { role: session.role, actorId: session.participantId, at };
  switch (message.type) {
    case 'request-submitted':
      return {
        ...base,
        type: message.type,
        participantId: session.participantId,
        requestId: createRequestId(),
        idea: message.idea,
        ...(message.vibe === undefined ? {} : { vibe: message.vibe }),
        ...(message.language === undefined
          ? {}
          : { language: message.language }),
      };
    case 'request-accepted':
    case 'request-declined':
    case 'recording-started':
    case 'recording-failed':
      return { ...base, type: message.type, requestId: message.requestId };
    case 'request-reordered':
      return {
        ...base,
        type: message.type,
        requestId: message.requestId,
        toIndex: message.toIndex,
      };
    case 'lyrics-ready':
      return {
        ...base,
        type: message.type,
        requestId: message.requestId,
        lyrics: message.lyrics,
      };
    case 'song-ready':
      return {
        ...base,
        type: message.type,
        requestId: message.requestId,
        shareId: message.shareId,
        startedAt: at,
      };
    case 'song-shared':
      return {
        ...base,
        type: message.type,
        shareId: message.shareId,
        lyrics: message.lyrics,
        startedAt: at,
      };
    case 'playback-updated':
      return {
        ...base,
        type: message.type,
        shareId: message.shareId,
        status: message.status,
        positionMs: message.positionMs,
        at: message.status === 'playing' ? at + SONG_START_DELAY_MS : at,
      };
    case 'kicked':
      return {
        ...base,
        type: message.type,
        participantId: message.participantId,
      };
    case 'room-expired':
      return { ...base, type: message.type };
  }
}

/** Owns authentication, persistence, projections, expiry, and dispatch. */
export function createRoomTransport<Socket>({
  storage,
  connections,
  now = Date.now,
  createParticipantId,
  createResumeCredential,
}: RoomTransportOptions<Socket>): RoomTransport<Socket> {
  const localSockets = new Set<Socket>();
  const activeSockets = () => connections.list?.() ?? localSockets;
  let state: RoomState | null = null;
  let metadata: RoomMetadata | null = null;

  async function load(): Promise<void> {
    if (!state) state = parseRoomState(await storage.get('state'));
    if (!metadata) metadata = parseMetadata(await storage.get('meta'));
  }

  async function persistState(nextState: RoomState): Promise<void> {
    state = nextState;
    await storage.put('state', nextState);
  }

  function sendError(socket: Socket, code: string): void {
    connections.send(socket, { type: 'error', code });
  }

  function broadcastSnapshots(): void {
    const currentState = state;
    if (!currentState) return;
    connections.broadcast((socket) => ({
      type: 'snapshot',
      state: projectRoomState(currentState, connections.getSession(socket)),
    }));
  }

  async function scheduleExpiry(): Promise<void> {
    if (!metadata) return;
    const someoneIsPresent = [...activeSockets()].some(
      (socket) => connections.getSession(socket)?.authenticated,
    );
    if (someoneIsPresent) metadata.emptyDeadline = null;
    else metadata.emptyDeadline ??= now() + EMPTY_GRACE_MS;
    await storage.put('meta', metadata);
    await storage.setAlarm(
      Math.min(metadata.absoluteDeadline, metadata.emptyDeadline ?? Infinity),
    );
  }

  function applyEffects(result: TransitionResult): void {
    for (const effect of result.effects) {
      if (effect.type === 'close-participant') {
        for (const socket of activeSockets()) {
          if (
            connections.getSession(socket)?.participantId ===
            effect.participantId
          ) {
            connections.close(socket, 4003, 'kicked');
          }
        }
      } else {
        for (const socket of activeSockets()) {
          connections.close(socket, 4004, 'expired');
        }
      }
    }
  }

  async function commit(result: TransitionResult): Promise<void> {
    await persistState(result.state);
    broadcastSnapshots();
    applyEffects(result);
  }

  async function apply(
    socket: Socket | null,
    event: RoomEvent,
  ): Promise<boolean> {
    if (!state) return false;
    const result = transitionRoom(state, event);
    if (result.error) {
      if (socket) sendError(socket, result.error.code);
      return false;
    }
    await commit(result);
    return true;
  }

  async function expireIfDue(): Promise<void> {
    if (!state || !metadata || state.expiredAt) return;
    if (
      now() >= metadata.absoluteDeadline ||
      (metadata.emptyDeadline !== null && now() >= metadata.emptyDeadline)
    ) {
      await apply(null, {
        type: 'room-expired',
        role: 'host',
        trustedAlarm: true,
        at: now(),
      });
    }
  }

  async function authenticateHost(
    socket: Socket,
    message: Extract<ClientMessage, { type: 'auth-host' }>,
  ): Promise<void> {
    if (!metadata || !state) return;
    const providedDigest = await sha256(message.secret);
    if (!constantTimeEqual(providedDigest, metadata.hostDigest)) {
      sendError(socket, 'auth-failed');
      connections.close(socket, 4001, 'auth-failed');
      return;
    }
    const result = transitionRoom(state, {
      type: 'joined',
      role: 'host',
      participantId: 'host',
      at: now(),
    });
    if (result.error) {
      sendError(socket, result.error.code);
      connections.close(socket, 4004, 'room-unavailable');
      return;
    }
    connections.setSession(socket, {
      authenticated: true,
      role: 'host',
      participantId: 'host',
    });
    await commit(result);
    await scheduleExpiry();
  }

  async function findResumedParticipant(
    credential: string,
  ): Promise<string | undefined> {
    if (!metadata) return undefined;
    const digest = await sha256(credential);
    const participantId = Object.keys(metadata.resumeDigests).find((id) =>
      constantTimeEqual(metadata?.resumeDigests[id], digest),
    );
    const wasKicked = metadata.kickedDigests.some((item) =>
      constantTimeEqual(item, digest),
    );
    return wasKicked ? undefined : participantId;
  }

  async function authenticateListener(
    socket: Socket,
    message: Extract<ClientMessage, { type: 'join' }>,
  ): Promise<void> {
    if (!metadata || !state) return;
    let participantId: string | undefined;
    let credential: string | undefined;
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
      ...(message.name === undefined ? {} : { name: message.name }),
      at: now(),
    });
    if (result.error) {
      sendError(socket, result.error.code);
      if (result.error.code === 'room-full') {
        connections.close(socket, 4002, 'room-full');
      } else if (result.error.code === 'room-expired') {
        connections.close(socket, 4004, 'room-unavailable');
      }
      return;
    }
    connections.setSession(socket, {
      authenticated: true,
      role: 'listener',
      participantId,
    });
    await commit(result);
    if (credential) {
      metadata.resumeDigests[participantId] = await sha256(credential);
      await storage.put('meta', metadata);
      connections.send(socket, { type: 'resume-credential', credential });
    }
    await scheduleExpiry();
  }

  async function authenticate(
    socket: Socket,
    message: ClientMessage,
  ): Promise<void> {
    if (message.type === 'auth-host') return authenticateHost(socket, message);
    if (message.type === 'join') return authenticateListener(socket, message);
    sendError(socket, 'authenticate-first');
  }

  function decodeMessage(socket: Socket, raw: unknown): ClientMessage | null {
    const isTooLarge =
      typeof raw !== 'string' ||
      new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES;
    if (isTooLarge) {
      sendError(socket, 'invalid-message');
      return null;
    }
    try {
      const message = parseClientMessage(JSON.parse(raw) as unknown);
      if (message) return message;
    } catch {
      // All malformed payloads receive the same private error.
    }
    sendError(socket, 'invalid-message');
    return null;
  }

  async function dispatchClientEvent(
    socket: Socket,
    message: ClientMessage,
    session: RoomSession,
  ): Promise<void> {
    if (
      message.type === 'auth-host' ||
      message.type === 'join' ||
      !session.role ||
      !session.participantId ||
      !metadata
    ) {
      sendError(socket, 'unknown-message');
      return;
    }
    const kickedParticipantId =
      message.type === 'kicked' ? message.participantId : undefined;
    const kickedDigest = kickedParticipantId
      ? metadata.resumeDigests[kickedParticipantId]
      : undefined;
    const event = clientEvent(
      message,
      {
        ...session,
        role: session.role,
        participantId: session.participantId,
      },
      now(),
      createParticipantId,
    );
    const accepted = await apply(socket, event);
    if (accepted && kickedDigest) {
      metadata.kickedDigests.push(kickedDigest);
      if (kickedParticipantId)
        delete metadata.resumeDigests[kickedParticipantId];
      await storage.put('meta', metadata);
    }
  }

  return {
    async initialize({
      roomId,
      hostDigest,
      openedAt = now(),
      expiresAt = openedAt + ABSOLUTE_ROOM_MS,
    }) {
      if (await storage.get('state')) return false;
      state = createRoomState({ roomId, openedAt, expiresAt });
      metadata = {
        hostDigest,
        absoluteDeadline: expiresAt,
        emptyDeadline: openedAt + EMPTY_GRACE_MS,
        resumeDigests: {},
        kickedDigests: [],
      };
      await storage.put('state', state);
      await storage.put('meta', metadata);
      await storage.setAlarm(Math.min(expiresAt, openedAt + EMPTY_GRACE_MS));
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
        connectedAt: now(),
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
      const session = connections.getSession(socket) ?? {
        authenticated: false,
      };
      if (!session.authenticated) return authenticate(socket, message);
      await dispatchClientEvent(socket, message, session);
    },

    async disconnect(socket) {
      await load();
      const session = connections.getSession(socket) ?? {
        authenticated: false,
      };
      localSockets.delete(socket);
      if (!state || !metadata) return;
      const participantStillConnected = [...activeSockets()].some(
        (candidate) => {
          if (candidate === socket) return false;
          const candidateSession = connections.getSession(candidate);
          return (
            candidateSession?.authenticated &&
            candidateSession.role === session.role &&
            candidateSession.participantId === session.participantId
          );
        },
      );
      if (
        session.authenticated &&
        session.role &&
        session.participantId &&
        !participantStillConnected
      ) {
        await apply(socket, {
          type: 'left',
          role: session.role,
          participantId: session.participantId,
          actorId: session.participantId,
          at: now(),
        });
      }
      await scheduleExpiry();
    },

    checkAuthenticationTimeout(socket) {
      const session = connections.getSession(socket);
      const waited = now() - (session?.connectedAt ?? 0);
      if (!session?.authenticated && waited >= AUTH_TIMEOUT_MS) {
        connections.close(socket, 4001, 'authentication-timeout');
      }
    },

    async alarm() {
      await load();
      if (!state || !metadata) return;
      const roomIsStillLive =
        now() < metadata.absoluteDeadline &&
        (metadata.emptyDeadline === null || now() < metadata.emptyDeadline);
      if (roomIsStillLive) {
        await storage.setAlarm(
          Math.min(
            metadata.absoluteDeadline,
            metadata.emptyDeadline ?? Infinity,
          ),
        );
        return;
      }
      await apply(null, {
        type: 'room-expired',
        role: 'host',
        trustedAlarm: true,
        at: now(),
      });
    },
  };
}
