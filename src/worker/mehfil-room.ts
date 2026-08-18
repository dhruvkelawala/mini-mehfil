import { DurableObject } from 'cloudflare:workers';

import {
  isBoolean,
  isNumber,
  isRecord,
  isString,
  randomBase64Url,
  type JsonValue,
} from '../room/primitives.ts';
import type { RoomSession } from '../room/protocol.ts';
import type {
  RoomConnections,
  RoomStorage,
  RoomTransport,
} from '../room/transport.ts';
import { createRoomTransport } from '../room/transport.ts';

type CloudflareRoomAdapters = {
  storage: RoomStorage;
  connections: RoomConnections<WebSocket>;
};

function createCloudflareRoomAdapters(
  ctx: DurableObjectState,
): CloudflareRoomAdapters {
  const parseSession = (
    value: JsonValue | undefined,
  ): RoomSession | undefined => {
    if (!isRecord(value) || !isBoolean(value.authenticated)) {
      return undefined;
    }
    const session: RoomSession = { authenticated: value.authenticated };
    const connectedAt = value.connectedAt;
    if (isNumber(connectedAt)) session.connectedAt = connectedAt;
    const role = value.role;
    if (role === 'host' || role === 'listener') session.role = role;
    const participantId = value.participantId;
    if (isString(participantId)) session.participantId = participantId;
    return session;
  };
  // SAFETY: attachments are always RoomSessions written by setSession; the
  // assertion only bridges the runtime's unknown return, and parseSession
  // re-validates every field with isRecord/isBoolean before it is used.
  const readSession = (socket: WebSocket): RoomSession | undefined =>
    parseSession(socket.deserializeAttachment() as JsonValue | undefined);
  const storage: RoomStorage = {
    get: (key) => ctx.storage.get(key),
    put: (key, value) => ctx.storage.put(key, value),
    setAlarm: (timestamp) => ctx.storage.setAlarm(timestamp),
  };
  const connections: RoomConnections<WebSocket> = {
    send(socket, message) {
      socket.send(JSON.stringify(message));
    },
    broadcast(createMessage) {
      for (const socket of ctx.getWebSockets()) {
        const session = readSession(socket);
        if (session?.authenticated) socket.send(createMessage(session));
      }
    },
    close(socket, code, reason) {
      socket.close(code, reason);
    },
    setSession(socket, value) {
      socket.serializeAttachment(value);
    },
    getSession(socket) {
      return readSession(socket);
    },
    list: () => ctx.getWebSockets(),
  };
  return { storage, connections };
}

type RoomInitializationPayload = {
  roomId: string;
  hostDigest: string;
  openedAt: number;
  expiresAt: number;
};

function parseInitialization(
  value: JsonValue | undefined,
): RoomInitializationPayload | null {
  if (!isRecord(value)) return null;
  const roomId = value.roomId;
  const hostDigest = value.hostDigest;
  const openedAt = value.openedAt;
  const expiresAt = value.expiresAt;
  if (
    !isString(roomId) ||
    !isString(hostDigest) ||
    !isNumber(openedAt) ||
    !isNumber(expiresAt)
  ) {
    return null;
  }
  return { roomId, hostDigest, openedAt, expiresAt };
}

/** Thin Cloudflare lifecycle adapter; room policy stays in the transport. */
export class MehfilRoom extends DurableObject<Env> {
  private readonly transport: RoomTransport<WebSocket>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const { storage, connections } = createCloudflareRoomAdapters(ctx);
    this.transport = createRoomTransport({
      storage,
      connections,
      createParticipantId: () => randomBase64Url(12),
      createResumeCredential: () => randomBase64Url(32),
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/initialize') {
      const data = parseInitialization(await request.json());
      if (!data)
        return new Response('Invalid room initialization', { status: 400 });
      const created = await this.transport.initialize(data);
      return new Response(null, { status: created ? 201 : 409 });
    }
    const isWebSocket =
      request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    if (url.pathname !== '/ws' || !isWebSocket) {
      return new Response('Not found', { status: 404 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    await this.transport.connect(server);
    setTimeout(() => this.transport.checkAuthenticationTimeout(server), 5_000);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    // SAFETY: the transport parses only JSON text and rejects every other
    // payload shape with the same invalid-message error, so collapsing the
    // runtime's string|ArrayBuffer union to JsonValue cannot change behavior.
    await this.transport.message(socket, message as JsonValue);
  }

  async webSocketClose(socket: WebSocket) {
    await this.transport.disconnect(socket);
  }

  async alarm() {
    await this.transport.alarm();
  }
}
