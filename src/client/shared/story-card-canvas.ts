/**
 * Draws a story card and hands it to the operating system share sheet.
 *
 * Both surfaces that offer a story card run exactly this module. The host app
 * imports it the ordinary way; the Worker's shared playback page has no
 * bundler, so `scripts/build-story-card.ts` compiles this file into the inline
 * script that page carries. That is why nothing here imports a value: the
 * compiled text has to stand on its own inside one `<script>` tag.
 *
 * Meta's Sharing to Stories flow is for native apps only — a web page cannot
 * write `com.instagram.sharedSticker.*` pasteboard items, and it cannot attach
 * an Instagram link sticker for the user. So the URL is painted into the
 * picture, and `share.text` repeats it for every other target.
 */

import type { StoryCard } from '../../shared/story-card.ts';

/** What pressing a story control actually did. */
export type StoryCardOutcome = 'shared' | 'saved' | 'cancelled';

const WIDTH = 1080;
const HEIGHT = 1920;
const PADDING = 96;
const SERIF = '"Iowan Old Style",Georgia,"Times New Roman",serif';
const SANS = '"Avenir Next","Gill Sans",-apple-system,"Segoe UI",sans-serif';
const NIGHT = '#142e2d';
const JPEG_QUALITY = 0.92;

const WORDMARK_BASELINE = 206;
const TITLE_BASELINE = 336;
const TITLE_MAX_SIZE = 88;
const TITLE_MIN_SIZE = 54;
const TITLE_MAX_LINES = 2;
const TITLE_LINE_HEIGHT = 1.16;
const STANZA_TOP_GAP = 92;
const STANZA_BOTTOM = 1636;
const STANZA_MIN_LINES = 2;
const PRIMARY_SIZE = 54;
const PRIMARY_LINE_HEIGHT = 70;
const SECONDARY_SIZE = 33;
const SECONDARY_LINE_HEIGHT = 44;
const SECONDARY_GAP = 8;
const STANZA_LINE_GAP = 34;
const RULE_Y = 1690;
const CAPTION_BASELINE = 1758;
const HOST_BASELINE = 1826;

interface MeasuredLine {
  primary: string[];
  secondary: string[];
  height: number;
}

function setFont(
  context: CanvasRenderingContext2D,
  weight: string,
  size: number,
  family: string,
): void {
  context.font = `${weight} ${String(size)}px ${family}`;
}

/**
 * Letter spacing is a recent canvas property; where it is missing the label
 * simply renders tight rather than not at all.
 */
function setTracking(context: CanvasRenderingContext2D, value: string): void {
  if ('letterSpacing' in context)
    (context as unknown as { letterSpacing: string }).letterSpacing = value;
}

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.trim().split(' ').filter(Boolean);
  const first = words[0];
  if (first === undefined) return [];
  const wrapped: string[] = [];
  let current = first;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? '';
    const candidate = `${current} ${word}`;
    if (context.measureText(candidate).width <= maxWidth) current = candidate;
    else {
      wrapped.push(current);
      current = word;
    }
  }
  wrapped.push(current);
  return wrapped;
}

/**
 * The shared playback page carries no `connect-src`, so `fetch` is refused
 * there while `img-src 'self'` is not. Loading through `Image` works on both
 * surfaces, and the same-origin background leaves the canvas untainted so
 * `toBlob` still returns bytes. A background that will not load resolves to
 * `null` and the card keeps its night-green fill.
 */
export function loadStoryBackground(
  url: string,
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', () => resolve(null));
    image.src = url;
  });
}

function paintScene(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | null,
): void {
  context.fillStyle = NIGHT;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  if (image && image.width && image.height) {
    const scale = Math.max(WIDTH / image.width, HEIGHT / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(
      image,
      (WIDTH - width) / 2,
      (HEIGHT - height) / 2,
      width,
      height,
    );
  }
  const crown = context.createLinearGradient(0, 0, 0, HEIGHT * 0.5);
  crown.addColorStop(0, 'rgba(6,18,17,.86)');
  crown.addColorStop(1, 'rgba(6,18,17,0)');
  context.fillStyle = crown;
  context.fillRect(0, 0, WIDTH, HEIGHT * 0.5);
  const hem = context.createLinearGradient(0, HEIGHT * 0.42, 0, HEIGHT);
  hem.addColorStop(0, 'rgba(5,17,16,0)');
  hem.addColorStop(1, 'rgba(5,17,16,.94)');
  context.fillStyle = hem;
  context.fillRect(0, HEIGHT * 0.42, WIDTH, HEIGHT * 0.58);
  context.fillStyle = 'rgba(230,166,83,.6)';
  context.fillRect(WIDTH / 2 - 58, RULE_Y, 116, 3);
}

/** Shrinks the title until it fits two lines, then gives up and clips to two. */
function fitTitle(
  context: CanvasRenderingContext2D,
  title: string,
  maxWidth: number,
): { lines: string[]; size: number } {
  let size = TITLE_MAX_SIZE;
  for (;;) {
    setFont(context, '600', size, SERIF);
    const lines = wrapText(context, title, maxWidth);
    if (lines.length <= TITLE_MAX_LINES || size <= TITLE_MIN_SIZE)
      return { lines: lines.slice(0, TITLE_MAX_LINES), size };
    size -= 6;
  }
}

function measureStanza(
  context: CanvasRenderingContext2D,
  card: StoryCard,
  maxWidth: number,
  available: number,
): MeasuredLine[] {
  const measured = card.stanza.map((line) => {
    setFont(context, '500', PRIMARY_SIZE, SERIF);
    const primary = wrapText(context, line.primary, maxWidth);
    setFont(context, '400', SECONDARY_SIZE, SANS);
    const secondary = line.secondary
      ? wrapText(context, line.secondary, maxWidth)
      : [];
    return {
      primary,
      secondary,
      height:
        primary.length * PRIMARY_LINE_HEIGHT +
        (secondary.length
          ? secondary.length * SECONDARY_LINE_HEIGHT + SECONDARY_GAP
          : 0) +
        STANZA_LINE_GAP,
    };
  });
  const total = () => measured.reduce((sum, entry) => sum + entry.height, 0);
  while (measured.length > STANZA_MIN_LINES && total() > available)
    measured.pop();
  return measured;
}

/**
 * Paints the whole card. The canvas is sized here rather than by the caller so
 * every surface produces the same 1080x1920 picture.
 */
export function drawStoryCard(
  canvas: HTMLCanvasElement,
  card: StoryCard,
  image: HTMLImageElement | null,
): void {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot draw a story card.');
  const centerX = WIDTH / 2;
  const maxWidth = WIDTH - PADDING * 2;

  paintScene(context, image);
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  // The page lifts its lyrics off the courtyard with a text shadow; the card
  // needs the same lift where the words cross the performers.
  context.shadowColor = 'rgba(4,15,14,.88)';
  context.shadowBlur = 28;
  context.shadowOffsetY = 6;

  setFont(context, '800', 30, SANS);
  context.fillStyle = '#e6a653';
  setTracking(context, '10px');
  context.fillText('MINI MEHFIL', centerX, WORDMARK_BASELINE);
  setTracking(context, '0px');

  const title = fitTitle(context, card.title, maxWidth);
  let y = TITLE_BASELINE;
  context.fillStyle = '#fff8ec';
  for (const line of title.lines) {
    context.fillText(line, centerX, y);
    y += title.size * TITLE_LINE_HEIGHT;
  }

  setFont(context, '700', 27, SANS);
  context.fillStyle = '#e9c27f';
  setTracking(context, '6px');
  context.fillText(card.label.toUpperCase(), centerX, y + 18);
  setTracking(context, '0px');

  const top = y + STANZA_TOP_GAP;
  const available = STANZA_BOTTOM - top;
  const stanza = measureStanza(context, card, maxWidth, available);
  const height = stanza.reduce((sum, entry) => sum + entry.height, 0);
  let lineY = top + Math.max(0, (available - height) / 2);
  for (const entry of stanza) {
    setFont(context, '500', PRIMARY_SIZE, SERIF);
    context.fillStyle = '#fff8ec';
    for (const text of entry.primary) {
      lineY += PRIMARY_LINE_HEIGHT;
      context.fillText(text, centerX, lineY);
    }
    if (entry.secondary.length) {
      setFont(context, '400', SECONDARY_SIZE, SANS);
      context.fillStyle = '#d8c3aa';
      lineY += SECONDARY_GAP;
      for (const text of entry.secondary) {
        lineY += SECONDARY_LINE_HEIGHT;
        context.fillText(text, centerX, lineY);
      }
    }
    lineY += STANZA_LINE_GAP;
  }

  setFont(context, '500', 30, SANS);
  context.fillStyle = '#ddcbb8';
  context.fillText('Hear the whole song at', centerX, CAPTION_BASELINE);
  setFont(context, '800', 56, SANS);
  context.fillStyle = '#f9edda';
  context.fillText(card.host, centerX, HOST_BASELINE);
}

/** Draws the card and encodes it as the JPEG a share sheet will accept. */
export async function storyCardBlob(card: StoryCard): Promise<Blob> {
  const image = await loadStoryBackground(card.backgroundUrl);
  const canvas = document.createElement('canvas');
  drawStoryCard(canvas, card, image);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error('The story card could not be encoded.')),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

/**
 * Probed with a throwaway file so a control can say what it will do before it
 * is pressed, rather than opening a share sheet that fails.
 */
export function canShareStoryCard(): boolean {
  try {
    if (typeof File !== 'function' || !navigator.canShare) return false;
    const probe = new File([new Uint8Array(1)], 'card.jpg', {
      type: 'image/jpeg',
    });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * Read by name rather than `instanceof`: a rejection can arrive from another
 * realm, where `Error` is a different intrinsic and `instanceof` is false.
 */
function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function saveStoryCard(blob: Blob, card: StoryCard): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = card.fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

/**
 * Opens the share sheet where the browser has one and downloads the card where
 * it does not. A cancelled sheet reports `cancelled` and leaves no file behind;
 * any other failure still gives the person their picture.
 */
export async function shareOrSaveStoryCard(
  blob: Blob,
  card: StoryCard,
): Promise<StoryCardOutcome> {
  const file = new File([blob], card.fileName, { type: 'image/jpeg' });
  const text = card.url ? `${card.title} · ${card.url}` : card.title;
  try {
    if (!navigator.canShare?.({ files: [file] })) {
      saveStoryCard(blob, card);
      return 'saved';
    }
    await navigator.share({ files: [file], title: card.title, text });
    return 'shared';
  } catch (error) {
    if (isAbort(error)) return 'cancelled';
    saveStoryCard(blob, card);
    return 'saved';
  }
}
