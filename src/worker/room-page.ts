import { isRoomId } from '../room/primitives.ts';

const ROOM_MARKER = '__MEHFIL_ROOM_ID__';

export interface ListenerAssetFetcher {
  fetch(request: Request): Promise<Response>;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function roomPage(
  roomId: string,
  assets: ListenerAssetFetcher,
): Promise<string> {
  if (!isRoomId(roomId)) throw new Error('Invalid room code.');
  const response = await assets.fetch(
    new Request('https://listener.assets/index.html'),
  );
  if (!response.ok) {
    throw new Error(`Listener shell unavailable (${response.status}).`);
  }
  const shell = await response.text();
  const markerCount = shell.split(ROOM_MARKER).length - 1;
  if (markerCount !== 1) {
    throw new Error(
      `Listener shell must contain exactly one room marker; found ${markerCount}.`,
    );
  }
  return shell.replace(ROOM_MARKER, escapeHtmlAttribute(roomId));
}
