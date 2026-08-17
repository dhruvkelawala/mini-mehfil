const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const root = path.join(__dirname, '..');
const iconGlyph = /[\u00a9\u00ae\u200d\u203c\u2049\u20e3\u2122\u2139\u2190-\u21ff\u2300-\u23ff\u2460-\u24ff\u25a0-\u27bf\u2b00-\u2bff\u3030\u303d\u3297\u3299\ufe0e\ufe0f\u{1f000}-\u{1faff}\u{e0020}-\u{e007f}]/u;

function trackedTextFiles() {
  const files = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean));
  files.add(path.relative(root, __filename));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return [...files].flatMap(file => {
    const buffer = fs.readFileSync(path.join(root, file));
    try {
      return [{ file, text: decoder.decode(buffer) }];
    } catch {
      return [];
    }
  });
}

test('tracked source contains no platform-dependent icon or emoji glyphs', () => {
  const findings = [];
  for (const { file, text } of trackedTextFiles()) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const match = iconGlyph.exec(line);
      if (!match) return;
      findings.push(`${file}:${index + 1} U+${match[0].codePointAt(0).toString(16).toUpperCase()}`);
    });
  }
  assert.deepEqual(findings, []);
});
