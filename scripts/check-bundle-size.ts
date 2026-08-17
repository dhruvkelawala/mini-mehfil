import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function manifest(surface: string): Record<string, ManifestChunk> {
  const raw: unknown = JSON.parse(
    readFileSync(resolve(`dist/${surface}/.vite/manifest.json`), 'utf8'),
  );
  if (!isRecord(raw)) throw new Error(`Invalid ${surface} Vite manifest.`);
  const chunks: Record<string, ManifestChunk> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.file !== 'string') {
      throw new Error(`Invalid chunk ${key} in ${surface} manifest.`);
    }
    chunks[key] = {
      file: value.file,
      ...(value.isEntry === true ? { isEntry: true } : {}),
      ...(Array.isArray(value.imports) &&
      value.imports.every((item) => typeof item === 'string')
        ? { imports: value.imports }
        : {}),
      ...(Array.isArray(value.css) &&
      value.css.every((item) => typeof item === 'string')
        ? { css: value.css }
        : {}),
    };
  }
  return chunks;
}

function gzipBytes(pathname: string): number {
  return gzipSync(readFileSync(pathname)).byteLength;
}

function measure(surface: string): { javascript: number; css: number } {
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
