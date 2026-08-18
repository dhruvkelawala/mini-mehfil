import { afterEach, expect, test, vi } from 'vitest';

import type { StoryCard } from '../../../src/shared/story-card.ts';
import {
  canShareStoryCard,
  drawStoryCard,
  shareOrSaveStoryCard,
} from '../../../src/client/shared/story-card-canvas.ts';

/**
 * Records every drawing call. `measureText` models an advance from the pixel
 * size in the font string, which is enough for the wrapping and fitting loops
 * to behave the way a browser's do.
 */
class Context {
  font = '';
  fillStyle: unknown = '';
  textAlign = '';
  textBaseline = '';
  letterSpacing = '0px';
  shadowColor = '';
  shadowBlur = 0;
  shadowOffsetY = 0;
  readonly texts: { text: string; x: number; y: number; font: string }[] = [];
  readonly rects: { y: number; fillStyle: unknown }[] = [];
  readonly images: { width: number; height: number }[] = [];
  createLinearGradient() {
    return { addColorStop() {} };
  }
  fillRect(_x: number, y: number) {
    this.rects.push({ y, fillStyle: this.fillStyle });
  }
  drawImage(
    _image: unknown,
    _x: number,
    _y: number,
    width: number,
    height: number,
  ) {
    this.images.push({ width, height });
  }
  fillText(text: string, x: number, y: number) {
    this.texts.push({ text, x, y, font: this.font });
  }
  measureText(text: string) {
    const size = Number(/(\d+)px/.exec(this.font)?.[1] ?? 20);
    return { width: text.length * size * 0.55 };
  }
  get painted() {
    return this.texts.map((entry) => entry.text).join('\n');
  }
}

class Canvas {
  width = 0;
  height = 0;
  readonly context = new Context();
  getContext() {
    return this.context;
  }
}

function card(overrides: Partial<StoryCard> = {}): StoryCard {
  return {
    title: 'Aloopuri Khavsa',
    label: 'Gujarati · Gujarati',
    url: 'https://minimehfil.wtf/s/AbCdEfGhIjKlMnOp',
    host: 'minimehfil.wtf',
    fileName: 'Aloopuri Khavsa.jpg',
    stanza: [{ primary: 'આ સાંજ ધીમે', secondary: 'aa saanj dhime' }],
    backgroundUrl: '/backgrounds/04-folk-modern-dusk.png',
    ...overrides,
  };
}

function draw(
  value: StoryCard,
  image: { width: number; height: number } | null,
) {
  const canvas = new Canvas();
  drawStoryCard(
    canvas as unknown as HTMLCanvasElement,
    value,
    image as HTMLImageElement | null,
  );
  return canvas;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the card paints the song, its lyrics and its host at story size', () => {
  const canvas = draw(card(), { width: 1600, height: 1000 });
  expect(canvas.width).toBe(1080);
  expect(canvas.height).toBe(1920);

  const painted = canvas.context.painted;
  expect(painted).toMatch(/MINI MEHFIL/);
  expect(painted).toMatch(/Aloopuri Khavsa/);
  expect(painted).toMatch(/GUJARATI · GUJARATI/);
  expect(painted, 'the native line is burned in').toContain('આ સાંજ ધીમે');
  expect(painted, 'the romanization sits under the native line').toContain(
    'aa saanj dhime',
  );
  expect(painted, 'the host is readable inside the picture').toContain(
    'minimehfil.wtf',
  );
});

test('the courtyard is cropped to fill the portrait frame', () => {
  const drawn = draw(card(), { width: 1600, height: 1000 }).context.images.at(
    0,
  );
  expect(drawn?.width).toBeGreaterThanOrEqual(1080);
  expect(drawn?.height).toBeGreaterThanOrEqual(1920);
});

test('a background that will not load leaves a card that still reads', () => {
  const canvas = draw(card(), null);
  expect(canvas.context.images).toHaveLength(0);
  expect(canvas.context.rects[0]?.fillStyle).toBe('#142e2d');
  expect(canvas.context.painted).toContain('Aloopuri Khavsa');
});

test('a long title and a long stanza stay above the footer', () => {
  const canvas = draw(
    card({
      title:
        'A Title So Long That It Could Never Fit Across Two Lines Of This Poster',
      stanza: Array.from({ length: 6 }, (_, index) => ({
        primary: `Line number ${String(index + 1)} of a chorus that keeps going`,
        secondary: '',
      })),
    }),
    { width: 1600, height: 1000 },
  );
  const serif = canvas.context.texts.filter((entry) =>
    entry.font.includes('Iowan'),
  );
  expect(serif.length).toBeGreaterThan(0);
  expect(
    serif.every((entry) => entry.y < 1690),
    'title and lyrics stop above the footer rule',
  ).toBe(true);
  expect(
    canvas.context.texts.every((entry) => entry.y <= 1880),
    'nothing spills past the bottom of the card',
  ).toBe(true);
});

test('a browser without file sharing says so before it is pressed', () => {
  vi.stubGlobal('navigator', {});
  expect(canShareStoryCard()).toBe(false);
  vi.stubGlobal('navigator', {
    canShare: () => {
      throw new Error('refused');
    },
  });
  expect(canShareStoryCard()).toBe(false);
  vi.stubGlobal('navigator', {
    canShare: (data: { files?: unknown[] }) => Array.isArray(data.files),
  });
  expect(canShareStoryCard()).toBe(true);
});

function stubSharing(share: (data: unknown) => Promise<void>) {
  const links: { download: string; clicks: number }[] = [];
  const shared: { files: File[]; text: string }[] = [];
  const objectUrls: Blob[] = [];
  vi.stubGlobal('navigator', {
    canShare: (data: { files?: unknown[] }) => Array.isArray(data.files),
    share: async (data: { files: File[]; text: string }) => {
      shared.push(data);
      await share(data);
    },
  });
  vi.stubGlobal('document', {
    body: { append() {} },
    createElement: () => {
      const link = {
        download: '',
        href: '',
        rel: '',
        clicks: 0,
        click() {
          this.clicks += 1;
        },
        remove() {},
      };
      links.push(link);
      return link;
    },
  });
  vi.stubGlobal('URL', {
    createObjectURL(blob: Blob) {
      objectUrls.push(blob);
      return 'blob:card';
    },
    revokeObjectURL() {},
  });
  vi.stubGlobal('setTimeout', () => 0);
  return { links, shared, objectUrls };
}

const BLOB = new Blob([new Uint8Array([255, 216, 255])], {
  type: 'image/jpeg',
});

test('the share sheet receives the picture and the link as text', async () => {
  const stubs = stubSharing(async () => undefined);
  expect(await shareOrSaveStoryCard(BLOB, card())).toBe('shared');
  expect(stubs.objectUrls, 'a shared card is never downloaded').toHaveLength(0);
  expect(stubs.shared[0]?.files[0]?.type).toBe('image/jpeg');
  expect(stubs.shared[0]?.files[0]?.name).toBe('Aloopuri Khavsa.jpg');
  expect(stubs.shared[0]?.text).toContain(
    'https://minimehfil.wtf/s/AbCdEfGhIjKlMnOp',
  );
});

test('a song with no link yet shares its title alone', async () => {
  const stubs = stubSharing(async () => undefined);
  await shareOrSaveStoryCard(BLOB, card({ url: '' }));
  expect(stubs.shared[0]?.text).toBe('Aloopuri Khavsa');
});

test('cancelling the share sheet leaves no file behind', async () => {
  const stubs = stubSharing(async () => {
    const cancelled = new Error('cancelled');
    cancelled.name = 'AbortError';
    throw cancelled;
  });
  expect(await shareOrSaveStoryCard(BLOB, card())).toBe('cancelled');
  expect(stubs.objectUrls).toHaveLength(0);
  expect(stubs.links).toHaveLength(0);
});

test('a share sheet that fails for any other reason still hands over the card', async () => {
  const stubs = stubSharing(async () => {
    throw new Error('the sheet broke');
  });
  expect(await shareOrSaveStoryCard(BLOB, card())).toBe('saved');
  expect(stubs.objectUrls).toHaveLength(1);
  expect(stubs.links[0]?.download).toBe('Aloopuri Khavsa.jpg');
  expect(stubs.links[0]?.clicks).toBe(1);
});

test('a browser with no file sharing downloads the card instead', async () => {
  const stubs = stubSharing(async () => undefined);
  vi.stubGlobal('navigator', {});
  expect(await shareOrSaveStoryCard(BLOB, card())).toBe('saved');
  expect(stubs.links[0]?.download).toBe('Aloopuri Khavsa.jpg');
});
