import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

import { test } from 'vitest';

const CARD_URL = 'https://minimehfil.wtf/og/mini-mehfil-card.jpg';
const CARD_PATH = new URL('../public/og/mini-mehfil-card.jpg', import.meta.url);
const SITE_HANDLE = '@dhruv_kelawala';
const ICON_PATHS = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png'];

/** Prettier wraps long meta tags, so match against one flat line of markup. */
function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(
    /\s+/g,
    ' ',
  );
}

/**
 * Readers reject a card that is not the size they advertise, so measure the
 * shipped bytes rather than trusting the filename. Walks the JPEG segment
 * chain to the first start-of-frame marker, which carries height then width.
 */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'not a JPEG');
  let offset = 2;
  while (offset < bytes.length - 1) {
    assert.equal(bytes[offset], 0xff, 'malformed JPEG segment');
    const marker = bytes[offset + 1];
    // SOF0/1/2/3, 5-7, 9-11, 13-15 hold the frame size; DHT/DAC/RST do not.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error('JPEG has no start-of-frame marker.');
}

test('the shared preview card is a 1200x630 image small enough to fetch', () => {
  const card = readFileSync(CARD_PATH);
  assert.deepEqual(jpegSize(card), { width: 1200, height: 630 });
  assert.ok(
    statSync(CARD_PATH).size < 300 * 1024,
    'the preview card must stay under 300 KiB',
  );
});

test('the home page sends a large summary card for its own link', () => {
  const html = read('../src/client/host/index.html');
  assert.match(html, /<meta name="description" content="[^"]{40,}"/);
  assert.match(html, /property="og:title" content="Mini Mehfil[^"]*"/);
  assert.match(html, /property="og:type" content="website"/);
  assert.match(html, /property="og:url" content="https:\/\/minimehfil\.wtf\/"/);
  assert.match(html, /property="og:description" content="[^"]{40,}"/);
  assert.match(html, new RegExp(`property="og:image" content="${CARD_URL}"`));
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, new RegExp(`name="twitter:image" content="${CARD_URL}"`));
  assert.match(
    html,
    new RegExp(`name="twitter:site" content="${SITE_HANDLE}"`),
  );
});

test('a room invitation sends a large summary card without a stale URL', () => {
  const html = read('../src/client/listener/index.html');
  assert.match(html, /<meta name="description" content="[^"]{40,}"/);
  assert.match(html, /property="og:title" content="[^"]*Mini Mehfil"/);
  assert.match(html, /property="og:type" content="website"/);
  assert.match(html, new RegExp(`property="og:image" content="${CARD_URL}"`));
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(
    html,
    new RegExp(`name="twitter:site" content="${SITE_HANDLE}"`),
  );
  // Every room has its own /r/CODE address, so a fixed og:url would point
  // every invitation at the wrong page. Readers fall back to the request URL.
  assert.doesNotMatch(html, /property="og:url"/);
  // The room marker contract in room-page.ts still holds: exactly one.
  assert.equal(html.split('__MEHFIL_ROOM_ID__').length - 1, 1);
});

test('the worker is configured with the deployed preview card', () => {
  const wrangler = read('../share/wrangler.jsonc');
  assert.match(
    wrangler,
    new RegExp(`"SHARE_PREVIEW_IMAGE_URL":\\s*"${CARD_URL}"`),
  );
  assert.match(wrangler, /"MEHFIL_PUBLIC_URL":\s*"https:\/\/minimehfil\.wtf"/);
});

test('the tab icon ships in the three formats browsers ask for', () => {
  for (const name of ICON_PATHS) {
    const path = new URL(`../public/${name}`, import.meta.url);
    assert.ok(statSync(path).size > 0, `${name} must exist and be non-empty`);
  }
  // The SVG carries the glyph as an outline, never a font-family: a browser
  // with no Devanagari font installed would otherwise render tofu.
  const svg = readFileSync(
    new URL('../public/favicon.svg', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(svg, /font-family|<text/);
  assert.match(svg, /<path[^>]+d="M/);
});

test('every surface links the tab icon, worker pages absolutely', () => {
  const host = read('../src/client/host/index.html');
  for (const name of ICON_PATHS) {
    assert.match(host, new RegExp(`href="/${name}"`));
  }

  // The Worker origin serves only dist/listener, so public/ never reaches it;
  // relative icon links would 404 on every room and share page.
  for (const path of [
    '../src/client/listener/index.html',
    '../src/worker/playback-page.ts',
  ]) {
    const markup = read(path);
    for (const name of ICON_PATHS) {
      assert.match(
        markup,
        new RegExp(`href="https://minimehfil.wtf/${name}"`),
        `${path} ${name}`,
      );
    }
  }
});
