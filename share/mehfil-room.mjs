import { createRoomTransport } from './room-transport.mjs';

function randomBase64Url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function createCloudflareRoomAdapters(state) {
  const storage = {
    get: key => state.storage.get(key),
    put: (key, value) => state.storage.put(key, value),
    setAlarm: timestamp => state.storage.setAlarm(timestamp)
  };

  const connections = {
    send(socket, message) {
      socket?.send(JSON.stringify(message));
    },
    broadcast(createMessage) {
      for (const socket of state.getWebSockets()) {
        if (socket.deserializeAttachment()?.authenticated) {
          socket.send(JSON.stringify(createMessage(socket)));
        }
      }
    },
    close(socket, code, reason) {
      socket?.close(code, reason);
    },
    setSession(socket, value) {
      socket.serializeAttachment(value);
    },
    getSession(socket) {
      return socket?.deserializeAttachment();
    },
    list() {
      return state.getWebSockets();
    }
  };

  return { storage, connections };
}

/**
 * The Durable Object for one live mehfil. Cloudflare constructs this class from
 * the ROOMS binding declared in wrangler.jsonc. Room behavior lives behind the
 * transport interface; this class only adapts lifecycle callbacks.
 */
export class MehfilRoom {
  constructor(state) {
    this.state = state;
    const { storage, connections } = createCloudflareRoomAdapters(state);
    this.transport = createRoomTransport({
      storage,
      connections,
      createParticipantId: () => randomBase64Url(12),
      createResumeCredential: () => randomBase64Url(32)
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/initialize') {
      const data = await request.json();
      const created = await this.transport.initialize(data);
      return new Response(null, { status: created ? 201 : 409 });
    }

    const isWebSocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    if (url.pathname !== '/ws' || !isWebSocket) {
      return new Response('Not found', { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    await this.transport.connect(server);
    setTimeout(() => this.transport.checkAuthenticationTimeout(server), 5_000);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    return this.transport.message(socket, message);
  }

  webSocketClose(socket) {
    return this.transport.disconnect(socket);
  }

  alarm() {
    return this.transport.alarm();
  }
}
