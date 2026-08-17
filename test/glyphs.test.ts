import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const iconGlyph = /[\u00a9\u00ae\u200d\u203c\u2049\u20e3\u2122\u2139\u2190-\u21ff\u2300-\u23ff\u2460-\u24ff\u25a0-\u27bf\u2b00-\u2bff\u3030\u303d\u3297\u3299\ufe0e\ufe0f\u{1f000}-\u{1faff}\u{e0020}-\u{e007f}]/u;

function trackedTextFiles() {
  const files = new Set(
    execFileSync('git', ['ls-files', '-z'], { cwd: root })
      .toString()
      .split('\0')
      .filter(Boolean),
  );
  files.add(relative(root, fileURLToPath(import.meta.url)));
  const decoder = new TextDecoder('utf-8', { fatal: true });

  return [...files].flatMap((file) => {
    try {
      return [{ file, text: decoder.decode(readFileSync(resolve(root, file))) }];
    } catch {
      return [];
    }
  });
}

test('tracked source contains no platform-dependent icon or emoji glyphs', () => {
  const findings: string[] = [];
  for (const { file, text } of trackedTextFiles()) {
    text.split('\n').forEach((line, index) => {
      const match = iconGlyph.exec(line);
      if (!match) return;
      findings.push(
        `${file}:${index + 1} U+${match[0].codePointAt(0)?.toString(16).toUpperCase()}`,
      );
    });
  }
  assert.deepEqual(findings, []);
});