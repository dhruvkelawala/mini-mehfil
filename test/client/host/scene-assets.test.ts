import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { test } from 'vitest';

test('the selected folk-modern scene ships with all four background candidates', () => {
  const backgrounds = readdirSync(
    new URL('../../../public/backgrounds', import.meta.url),
  )
    .filter((file) => file.endsWith('.png'))
    .sort();
  const styles = readFileSync(
    new URL('../../../src/client/host/styles.css', import.meta.url),
    'utf8',
  );
  const html = readFileSync(
    new URL('../../../src/client/host/index.html', import.meta.url),
    'utf8',
  );
  const app = readFileSync(
    new URL('../../../src/client/host/App.tsx', import.meta.url),
    'utf8',
  );

  assert.deepEqual(backgrounds, [
    '01-lantern-courtyard.png',
    '02-editorial-rooftop.png',
    '03-moonlit-arch.png',
    '04-folk-modern-dusk.png',
  ]);
  assert.match(
    styles,
    /\.scene\s*\{[\s\S]*background-image:\s*url\('\/backgrounds\/04-folk-modern-dusk\.png'\)/,
  );
  assert.match(
    html,
    /rel="preload"[\s\S]*href="\/backgrounds\/04-folk-modern-dusk\.png"/,
  );
  assert.doesNotMatch(html, /background-prototype/);
  assert.match(
    app,
    /class="topbar-docs"[\s\S]*href="https:\/\/platform\.minimax\.io\/docs\/api-reference\/music-generation"/,
  );
  assert.match(
    styles,
    /@media \(max-width: 560px\)[\s\S]*\.topbar-docs\s*\{\s*display:\s*none;\s*\}/,
  );
  assert.doesNotMatch(app, /Lyrics cost about a tenth of a cent/);
  assert.doesNotMatch(styles, /\.cost-hint/);
});