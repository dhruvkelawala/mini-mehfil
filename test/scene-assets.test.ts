import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { test } from 'vitest';

test('the selected folk-modern scene ships with all four background candidates', () => {
  const backgrounds = readdirSync(
    new URL('../public/backgrounds', import.meta.url),
  )
    .filter((file) => file.endsWith('.png'))
    .sort();
  const hostStyles = readFileSync(
    new URL('../src/client/host/styles.css', import.meta.url),
    'utf8',
  );
  const hostHtml = readFileSync(
    new URL('../src/client/host/index.html', import.meta.url),
    'utf8',
  );
  const listenerStyles = readFileSync(
    new URL('../src/client/listener/styles.css', import.meta.url),
    'utf8',
  );
  const listenerHtml = readFileSync(
    new URL('../src/client/listener/index.html', import.meta.url),
    'utf8',
  );
  const worker = readFileSync(
    new URL('../src/worker/index.ts', import.meta.url),
    'utf8',
  );
  const app = readFileSync(
    new URL('../src/client/host/App.tsx', import.meta.url),
    'utf8',
  );
  const viteConfig = readFileSync(
    new URL('../vite.config.ts', import.meta.url),
    'utf8',
  );

  assert.deepEqual(backgrounds, [
    '01-lantern-courtyard.png',
    '02-editorial-rooftop.png',
    '03-moonlit-arch.png',
    '04-folk-modern-dusk.png',
  ]);
  assert.match(
    hostStyles,
    /\.scene\s*\{[\s\S]*background-image:\s*url\('\/backgrounds\/04-folk-modern-dusk\.png'\)/,
  );
  assert.match(
    hostHtml,
    /rel="preload"[\s\S]*href="\/backgrounds\/04-folk-modern-dusk\.png"/,
  );
  assert.match(
    listenerStyles,
    /\.scene\s*\{[\s\S]*background-image:\s*url\('\/backgrounds\/04-folk-modern-dusk\.png'\)/,
  );
  assert.match(
    listenerHtml,
    /rel="preload"[\s\S]*href="\/backgrounds\/04-folk-modern-dusk\.png"/,
  );
  assert.match(worker, /pathname\.startsWith\('\/backgrounds\/'\)/);
  assert.doesNotMatch(hostHtml, /background-prototype/);
  assert.match(
    app,
    /class="topbar-docs"[\s\S]*href="https:\/\/platform\.minimax\.io\/docs\/api-reference\/music-generation"/,
  );
  assert.match(
    hostStyles,
    /@media \(max-width: 560px\)[\s\S]*\.topbar-docs\s*\{\s*display:\s*none;\s*\}/,
  );
  assert.doesNotMatch(app, /Lyrics cost about a tenth of a cent/);
  assert.doesNotMatch(hostStyles, /\.cost-hint/);
  assert.match(viteConfig, /publicDir:\s*resolve\('public'\)/);
});
