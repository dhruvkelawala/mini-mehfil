import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isRecord, isString, type JsonValue } from '../src/room/primitives.ts';

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  css?: string[];
}

interface Budget {
  surface: 'host' | 'listener';
  javascript: number;
  css: number;
}

function parseManifestChunk(
  surface: string,
  key: string,
  value: JsonValue | undefined,
): ManifestChunk {
  if (!isRecord(value))
    throw new Error(`Invalid chunk ${key} in ${surface} manifest.`);
  const file = value.file;
  if (!isString(file))
    throw new Error(`Invalid chunk ${key} in ${surface} manifest.`);
  const chunk: ManifestChunk = { file };
  if (value.isEntry === true) chunk.isEntry = true;
  const imports = value.imports;
  if (Array.isArray(imports) && imports.every((item) => isString(item))) {
    chunk.imports = imports;
  }
  const css = value.css;
  if (Array.isArray(css) && css.every((item) => isString(item))) {
    chunk.css = css;
  }
  return chunk;
}

function manifest(surface: string) {
  const raw: JsonValue = JSON.parse(
    readFileSync(resolve(`dist/${surface}/.vite/manifest.json`), 'utf8'),
  );
  if (!isRecord(raw)) throw new Error(`Invalid ${surface} Vite manifest.`);
  const chunks: Record<string, ManifestChunk> = {};
  for (const [key, value] of Object.entries(raw)) {
    chunks[key] = parseManifestChunk(surface, key, value);
  }
  return chunks;
}

function gzipBytes(pathname: string): number {
  return gzipSync(readFileSync(pathname)).byteLength;
}

function measure(surface: string) {
  const chunks = manifest(surface);
  const entry = Object.entries(chunks).find(([, chunk]) => chunk.isEntry);
  if (!entry) throw new Error(`${surface} manifest has no entry.`);
  const visited = new Set<string>();
  const css = new Set<string>();
  let javascript = 0;
  const visit = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = chunks[key];
    if (!chunk)
      throw new Error(`Missing static import ${key} in ${surface} manifest.`);
    if (chunk.file.endsWith('.js')) {
      javascript += gzipBytes(resolve(`dist/${surface}`, chunk.file));
    }
    for (const stylesheet of chunk.css ?? []) css.add(stylesheet);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  };
  visit(entry[0]);
  return {
    javascript,
    css: [...css].reduce(
      (total, stylesheet) =>
        total + gzipBytes(resolve(`dist/${surface}`, stylesheet)),
      0,
    ),
  };
}

const budgets: Budget[] = [
  { surface: 'host', javascript: 35 * 1024, css: 15 * 1024 },
  { surface: 'listener', javascript: 25 * 1024, css: 15 * 1024 },
];
let failed = false;
console.log('Surface   JS gzip       CSS gzip');
for (const budget of budgets) {
  const size = measure(budget.surface);
  console.log(
    `${budget.surface.padEnd(9)} ${(size.javascript / 1024).toFixed(2).padStart(6)} KiB    ${(size.css / 1024).toFixed(2).padStart(6)} KiB`,
  );
  if (size.javascript > budget.javascript || size.css > budget.css)
    failed = true;
}
if (failed) throw new Error('A browser entry exceeds its gzip budget.');
