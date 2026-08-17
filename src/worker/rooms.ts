import { roomPage } from '../../share/room-page.mjs';
import { constantTimeEqual, sha256 } from '../room/transport.ts';

const ROOM_ID_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000;

type RoomInitialization = {
  hostDigest: string;
  openedAt: number;
  expiresAt: number;
};

export interface RoomDirectory {
  initialize(roomId: string, data: RoomInitialization): Promise<boolean>;
  connect(roomId: string, request: Request): Promise<Response>;
}

type RoomPageRenderer = (roomId: string, nonce: string) => string;
const renderLegacyRoomPage: RoomPageRenderer = (roomId, nonce) =>
  String(roomPage(roomId, nonce));

interface RoomRouterOptions {
  directory: RoomDirectory;
  rateLimit?: (caller: string) => Promise<boolean>;
  secret?: string;
  renderPage?: RoomPageRenderer;
  createCode?: () => string;
  createHostSecret?: () => string;
  now?: () => number;
}

function json(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function randomRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

/**
 * Adapts a Cloudflare Durable Object namespace to the interface used by the
 * room router. idFromName guarantees that one room code reaches one object.
 */
export function createDurableRoomDirectory(
  namespace: DurableObjectNamespace,
): RoomDirectory {
  return {
    async initialize(roomId: string, data: RoomInitialization) {
      const id = namespace.idFromName(roomId);
      const room = namespace.get(id);
      const response = await room.fetch('https://room.internal/initialize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId, ...data }),
      });
      return response.status === 201;
    },

    connect(roomId: string, request: Request) {
      const id = namespace.idFromName(roomId);
      const room = namespace.get(id);
      return room.fetch(new Request('https://room.internal/ws', request));
    },
  };
}

/**
 * Creates the room HTTP module. Non-room requests return null so the Worker can
 * fall through to sharing without coupling the two modules.
 */
export function createRoomRouter({
  directory,
  rateLimit = () => Promise.resolve(true),
  secret = '',
  renderPage = renderLegacyRoomPage,
  createCode = randomRoomCode,
  createHostSecret = () => randomBase64Url(32),
  now = Date.now,
}: RoomRouterOptions) {
  return async function routeRoomRequest(
    request: Request,
  ): Promise<Response | null> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/rooms') {
      if (!secret) return json({ error: 'Rooms are not configured.' }, 503);

      const authorization = request.headers.get('authorization') || '';
      const provided = authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : '';
      const [expectedDigest, providedDigest] = await Promise.all([
        sha256(secret),
        sha256(provided),
      ]);
      if (!provided || !constantTimeEqual(providedDigest, expectedDigest)) {
        return json(
          { error: 'Room credentials are missing or invalid.' },
          401,
          { 'www-authenticate': 'Bearer' },
        );
      }

      const caller = request.headers.get('cf-connecting-ip') || 'unknown';
      if (!(await rateLimit(caller))) {
        return json(
          { error: 'Too many rooms are opening at once. Please try again.' },
          429,
          { 'retry-after': '60' },
        );
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const roomId = createCode();
        if (!ROOM_ID_PATTERN.test(roomId)) continue;

        const hostSecret = createHostSecret();
        const openedAt = now();
        const expiresAt = openedAt + ROOM_LIFETIME_MS;
        const initialized = await directory.initialize(roomId, {
          hostDigest: await sha256(hostSecret),
          openedAt,
          expiresAt,
        });

        if (!initialized) continue;

        return json(
          {
            roomId,
            joinUrl: `${url.origin}/r/${roomId}`,
            socketUrl: `${url.origin.replace(/^http/, 'ws')}/rooms/${roomId}/ws`,
            hostSecret,
            expiresAt,
          },
          201,
        );
      }

      return json({ error: 'Could not open a room. Please retry.' }, 503);
    }

    const join = url.pathname.match(
      /^\/r\/([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8})$/,
    );
    if (join && (request.method === 'GET' || request.method === 'HEAD')) {
      const roomId = join[1];
      if (!roomId) return json({ error: 'Invalid room.' }, 400);
      const nonce = randomBase64Url(12);
      const html = renderPage(roomId, nonce);
      return new Response(request.method === 'HEAD' ? null : html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': [
            "default-src 'none'",
            "connect-src 'self'",
            "media-src 'self' blob:",
            `style-src 'nonce-${nonce}'`,
            `script-src 'nonce-${nonce}'`,
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join('; '),
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    const socket = url.pathname.match(
      /^\/rooms\/([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8})\/ws$/,
    );
    if (socket && request.method === 'GET') {
      const roomId = socket[1];
      if (!roomId) return json({ error: 'Invalid room.' }, 400);
      return directory.connect(roomId, request);
    }

    return null;
  };
}
