import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseTcpPort(value: string, source: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${source} must be an integer TCP port from 1 to 65535.`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} must be an integer TCP port from 1 to 65535.`);
  }
  return port;
}

export function isDirectEntry(
  moduleUrl: string,
  entry = process.argv[1],
): boolean {
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return path.resolve(entry) === fileURLToPath(moduleUrl);
  }
}
