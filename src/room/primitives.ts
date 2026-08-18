export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonRecord = Record<string, JsonValue>;

export function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

export function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number';
}

export function isFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === 'boolean';
}

export const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_ID_SOURCE = `[${ROOM_ID_ALPHABET}]{8}`;
export const ROOM_ID_PATTERN = new RegExp(`^${ROOM_ID_SOURCE}$`);

export function isRoomId(value: JsonValue | undefined): value is string {
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
