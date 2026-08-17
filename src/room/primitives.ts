export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_ID_SOURCE = `[${ROOM_ID_ALPHABET}]{8}`;
export const ROOM_ID_PATTERN = new RegExp(`^${ROOM_ID_SOURCE}$`);

export function isRoomId(value: unknown): value is string {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function randomBase64Url(
  byteLength: number,
  random: {
    getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  } = crypto,
): string {
  const bytes = new Uint8Array(byteLength);
  random.getRandomValues(bytes);
  return base64Url(bytes);
}
