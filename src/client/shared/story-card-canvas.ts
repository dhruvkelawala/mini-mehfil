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

/** The stretch of the song a moving card plays. */
export interface StoryClip {
  start: number;
  seconds: number;
}

/** What pressing a story control actually did. */
export type StoryCardOutcome = 'shared' | 'saved' | 'cancelled';

/**
 * Where a moving card is in its clip. Absent for the still card, which is
 * drawn exactly as it always was.
 */
export interface StoryFrame {
  /** 0 through 1 across the clip. */
  progress: number;
  /** The stanza line being sung, or -1 before any of them. */
  activeLine: number;
}

/**
 * Meta's Sharing to Stories doc asks for up to 20 seconds. Instagram itself
 * takes longer clips and splits them, so the lengths on offer run past that;
 * 20 stays the one documented to arrive whole.
 */
export const STORY_CLIP_LENGTHS = [10, 15, 20, 30];
const CLIP_MAX_SECONDS = 30;
const CLIP_MIN_SECONDS = 5;

/** How far the courtyard drifts across a clip, as a fraction of its size. */
const SCENE_DRIFT = 0.06;
/** A stanza line that is not the one being sung. */
const RESTING_LINE = 'rgba(255,248,236,.42)';
const RESTING_SECONDARY = 'rgba(216,195,170,.38)';
const VIDEO_BITS_PER_SECOND = 6_000_000;
const CAPTURE_FRAMES_PER_SECOND = 30;
/**
 * Ordered by preference. Safari has recorded MP4 since its first
 * MediaRecorder; Chrome gained MP4 muxing in 126. WebM is deliberately absent:
 * MP4 works everywhere WebM does, and Meta documents MP4.
 */
const VIDEO_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
];

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
let loaded: { url: string; image: HTMLImageElement | null } | null = null;

export function loadStoryBackground(
  url: string,
): Promise<HTMLImageElement | null> {
  if (loaded?.url === url) return Promise.resolve(loaded.image);
  return new Promise((resolve) => {
    const image = new Image();
    const settle = (value: HTMLImageElement | null) => {
      loaded = { url, image: value };
      resolve(value);
    };
    image.addEventListener('load', () => settle(image));
    image.addEventListener('error', () => settle(null));
    image.src = url;
  });
}

/** The memoized background, or `null` when it has not loaded yet. */
export function readyStoryBackground(url: string): HTMLImageElement | null {
  return loaded?.url === url ? loaded.image : null;
}

function paintScene(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | null,
  drift: number,
): void {
  context.fillStyle = NIGHT;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  if (image && image.width && image.height) {
    const scale =
      Math.max(WIDTH / image.width, HEIGHT / image.height) * (1 + drift);
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
 * every surface produces the same 1080x1920 picture. Pass a `frame` to draw
 * one moment of the moving card; omit it for the still one.
 */
export function drawStoryCard(
  canvas: HTMLCanvasElement,
  card: StoryCard,
  image: HTMLImageElement | null,
  frame?: StoryFrame,
): void {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot draw a story card.');
  const centerX = WIDTH / 2;
  const maxWidth = WIDTH - PADDING * 2;

  paintScene(context, image, frame ? SCENE_DRIFT * frame.progress : 0);
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
  for (const [index, entry] of stanza.entries()) {
    // On the still card every line is equal. On the moving one the line being
    // sung carries the frame and the rest step back.
    const singing = !frame || frame.activeLine === index;
    setFont(context, '500', PRIMARY_SIZE, SERIF);
    context.fillStyle = singing ? '#fff8ec' : RESTING_LINE;
    for (const text of entry.primary) {
      lineY += PRIMARY_LINE_HEIGHT;
      context.fillText(text, centerX, lineY);
    }
    if (entry.secondary.length) {
      setFont(context, '400', SECONDARY_SIZE, SANS);
      context.fillStyle = singing ? '#d8c3aa' : RESTING_SECONDARY;
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

/**
 * The stretch of song a moving card plays: the section the card quotes, so the
 * words on screen are the words being sung. Without a trusted timeline it opens
 * partway in, because the first seconds are usually an intro.
 *
 * Decided in the browser rather than on the server, because only the browser
 * knows how long the recording actually is.
 */
export function storyClipAt(
  startSeconds: number,
  durationSeconds: number,
  wantedSeconds = CLIP_MAX_SECONDS,
): StoryClip {
  const duration = Number.isFinite(durationSeconds) ? durationSeconds : 0;
  const longest = Math.min(wantedSeconds, CLIP_MAX_SECONDS, duration);
  const start = Math.min(
    Math.max(0, startSeconds),
    Math.max(0, duration - longest),
  );
  return { start, seconds: Math.max(0, Math.min(longest, duration - start)) };
}

/** True when a stretch of song is long enough to be worth recording. */
export function isRecordableClip(clip: StoryClip): boolean {
  return clip.seconds >= CLIP_MIN_SECONDS;
}

/**
 * The MP4 flavour this browser records, or `null` when it records none.
 *
 * Probed rather than inferred from a version: WebKit publishes no
 * `isTypeSupported` table for any shipped build, so the browser is the only
 * authority on what it will actually accept.
 */
export function storyVideoType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return (
    VIDEO_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
  );
}

/**
 * A media element may only be given to `createMediaElementSource` once, so the
 * node is kept for the life of the element.
 */
interface SongTap {
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
}
const taps = new WeakMap<HTMLMediaElement, SongTap>();

/**
 * Routes the song into a recordable stream. The source is also connected to
 * `context.destination`, because the Web Audio spec stops the element being
 * heard directly once a source node exists — without it the person watches a
 * silent recording of the song they are recording.
 */
function tapSong(audio: HTMLMediaElement): SongTap {
  const existing = taps.get(audio);
  if (existing) return existing;
  const context = new AudioContext();
  const source = context.createMediaElementSource(audio);
  const destination = context.createMediaStreamDestination();
  source.connect(destination);
  source.connect(context.destination);
  const tap = { context, destination };
  taps.set(audio, tap);
  return tap;
}

/**
 * Makes a previously recorded-from element audible again. Once
 * `createMediaElementSource` exists the element sounds only through its
 * `AudioContext`, and a suspended context plays silence — so scrubbing after
 * one recording would be mute without this.
 */
export function ensureSongAudible(audio: HTMLMediaElement): void {
  const tap = taps.get(audio);
  if (tap && tap.context.state === 'suspended') void tap.context.resume();
}

export interface StoryVideoOptions {
  /** Drawn on while recording, so the person watches rather than waits. */
  canvas: HTMLCanvasElement;
  card: StoryCard;
  audio: HTMLMediaElement;
  clipStart: number;
  seconds: number;
  /**
   * When the song's own timing is trusted, the moment each stanza line is
   * sung. The card then lights the line the singer is on rather than dividing
   * the clip evenly and hoping.
   */
  lineStarts?: number[];
  onProgress?: (fraction: number) => void;
}

/**
 * Records the moving card and the song into one MP4.
 *
 * This runs in real time — the recorder is fed by live streams, and a live
 * stream runs at one second per second. It also cannot survive the page being
 * hidden: hidden documents leave the rendering steps, canvas capture only
 * produces a frame when the canvas is painted, and WebKit interrupts the
 * `AudioContext` on entering the background. So backgrounding aborts rather
 * than yielding a frozen file.
 *
 * The caller must still open the share sheet from a fresh press: transient
 * activation does not survive the length of the clip.
 */
export async function recordStoryVideo(
  options: StoryVideoOptions,
): Promise<Blob> {
  const { canvas, card, audio, clipStart, seconds, lineStarts, onProgress } =
    options;
  const type = storyVideoType();
  if (!type) throw new Error('This browser cannot record a story video.');

  const tap = tapSong(audio);
  if (tap.context.state === 'suspended') await tap.context.resume();
  const image =
    readyStoryBackground(card.backgroundUrl) ??
    (await loadStoryBackground(card.backgroundUrl));
  drawStoryCard(canvas, card, image, { progress: 0, activeLine: -1 });

  const captured = canvas.captureStream(CAPTURE_FRAMES_PER_SECOND);
  const stream = new MediaStream([
    ...captured.getVideoTracks(),
    ...tap.destination.stream.getAudioTracks(),
  ]);
  const recorder = new MediaRecorder(stream, {
    mimeType: type,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  });
  const parts: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size) parts.push(event.data);
  });
  const recorded = new Promise<Blob>((resolve, reject) => {
    recorder.addEventListener('stop', () => resolve(new Blob(parts, { type })));
    recorder.addEventListener('error', () =>
      reject(new Error('The recording failed.')),
    );
  });

  audio.currentTime = clipStart;
  await audio.play();
  recorder.start();
  try {
    await new Promise<void>((resolve, reject) => {
      let frame = 0;
      const finish = (error?: Error) => {
        cancelAnimationFrame(frame);
        document.removeEventListener('visibilitychange', watchVisibility);
        if (error) reject(error);
        else resolve();
      };
      const watchVisibility = () => {
        if (document.hidden)
          finish(new Error('The recording stopped when the page was hidden.'));
      };
      document.addEventListener('visibilitychange', watchVisibility);
      const tick = () => {
        const elapsed = audio.currentTime - clipStart;
        const progress = Math.min(1, Math.max(0, elapsed / seconds));
        const activeLine = lineStarts?.length
          ? lineStarts.reduce(
              (at, start, index) => (audio.currentTime >= start ? index : at),
              0,
            )
          : Math.min(
              card.stanza.length - 1,
              Math.floor(progress * card.stanza.length),
            );
        drawStoryCard(canvas, card, image, { progress, activeLine });
        onProgress?.(progress);
        if (progress >= 1 || audio.ended) {
          finish();
          return;
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
  } finally {
    audio.pause();
    if (recorder.state !== 'inactive') recorder.stop();
    for (const track of captured.getVideoTracks()) track.stop();
  }
  return recorded;
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
