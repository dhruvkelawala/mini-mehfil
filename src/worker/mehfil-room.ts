import { DurableObject } from 'cloudflare:workers';

import { randomBase64Url } from '../room/primitives.ts';
import { isRecord } from '../room/protocol.ts';
import type { RoomSession } from '../room/protocol.ts';
import type {
  RoomConnections,
  RoomStorage,
  RoomTransport,
} from '../room/transport.ts';
import { createRoomTransport } from '../room/transport.ts';

function createCloudflareRoomAdapters(ctx: DurableObjectState): {
  storage: RoomStorage;
  connections: RoomConnections<WebSocket>;
} {
  const parseSession = (value: unknown): RoomSession | undefined => {
    if (!isRecord(value) || typeof value.authenticated !== 'boolean') {
      return undefined;
    }
    return {
      authenticated: value.authenticated,
      ...(typeof value.connectedAt === 'number'
        ? { connectedAt: value.connectedAt }
        : {}),
      ...(value.role === 'host' || value.role === 'listener'
        ? { role: value.role }
        : {}),
      ...(typeof value.participantId === 'string'
        ? { participantId: value.participantId }
        : {}),
    };
  };
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
        const session = parseSession(socket.deserializeAttachment());
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
      return parseSession(socket.deserializeAttachment());
    },
    list: () => ctx.getWebSockets(),
  };
  return { storage, connections };
}

function parseInitialization(value: unknown): {
  roomId: string;
  hostDigest: string;
  openedAt: number;
  expiresAt: number;
} | null {
  if (
    !isRecord(value) ||
    typeof value.roomId !== 'string' ||
    typeof value.hostDigest !== 'string' ||
    typeof value.openedAt !== 'number' ||
    typeof value.expiresAt !== 'number'
  ) {
    return null;
  }
  return {
    roomId: value.roomId,
    hostDigest: value.hostDigest,
    openedAt: value.openedAt,
    expiresAt: value.expiresAt,
  };
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
    await this.transport.message(socket, message);
  }

  async webSocketClose(socket: WebSocket) {
    await this.transport.disconnect(socket);
  }

  async alarm() {
    await this.transport.alarm();
  }
}
