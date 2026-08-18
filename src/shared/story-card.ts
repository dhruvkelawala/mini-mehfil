/**
 * What a story card says, decided once for every surface that offers one.
 *
 * The host app and the Worker's shared playback page both hand a person the
 * same 1080x1920 picture, so the choices that make it a good card — which
 * stanza it quotes, what the file is called, which host is painted on it —
 * live here rather than being made twice. Drawing it lives in
 * `src/client/shared/story-card-canvas.ts`, which needs a browser; nothing in
 * this module does, so the Worker can decide all of this while it renders.
 */

import type { LyricLine, LyricSection } from '../lyrics/lyric-sync.ts';

export interface StoryCardLine {
  primary: string;
  secondary: string;
}

export interface StoryCard {
  title: string;
  /** Language, and the native script name when there is one. */
  label: string;
  /** Link the share text carries, or `''` when the song has no link yet. */
  url: string;
  /** Host painted into the picture, so a screenshot still leads home. */
  host: string;
  fileName: string;
  stanza: StoryCardLine[];
  backgroundUrl: string;
}

/** More than this and the card stops being readable in two seconds. */
const STANZA_MAX_LINES = 6;
/** A chorus shorter than this cannot carry the card on its own. */
const CHORUS_MIN_LINES = 3;
const RESERVED_FILE_NAME_CHARACTERS = '<>:"/\\|?*';
const FILE_NAME_MAX_LENGTH = 60;

function quoted(line: LyricLine): StoryCardLine {
  return { primary: line.primary, secondary: line.secondary };
}

function sungLines(section: LyricSection): LyricLine[] {
  return section.lines.filter((line) => !line.cue);
}

/**
 * The lines the card quotes: the chorus when the sheet names one long enough
 * to stand alone, otherwise the longest section. A Story is watched for about
 * two seconds with the sound off, so one stanza beats a scrape of the sheet.
 *
 * Falls back to the flat line list for sheets that carry no section cues.
 */
export function storyStanza(
  sections: LyricSection[],
  lines: LyricLine[],
): StoryCardLine[] {
  const groups = sections.map(sungLines).filter((group) => group.length > 0);
  if (groups.length === 0)
    return lines
      .filter((line) => !line.cue)
      .slice(0, STANZA_MAX_LINES)
      .map(quoted);
  const chorus = sections.find(
    (section) =>
      section.family === 'chorus' &&
      sungLines(section).length >= CHORUS_MIN_LINES,
  );
  const group = chorus
    ? sungLines(chorus)
    : groups.reduce((best, next) => (next.length > best.length ? next : best));
  return group.slice(0, STANZA_MAX_LINES).map(quoted);
}

/**
 * A name every share sheet and file system accepts. Reserved characters become
 * spaces rather than disappearing, so `Rain/Refrain` stays two readable words.
 */
export function storyFileName(title: string): string {
  let name = '';
  for (const character of title)
    name += RESERVED_FILE_NAME_CHARACTERS.includes(character) ? ' ' : character;
  const trimmed = name.trim().slice(0, FILE_NAME_MAX_LENGTH).trim();
  return `${trimmed || 'Mini Mehfil'}.jpg`;
}

/**
 * The host painted onto the card. Matched by pattern rather than parsed with
 * `URL`, so a malformed origin cannot throw inside page rendering.
 */
export function storyCardHost(origin: string): string {
  return (
    /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(origin)?.[1] ?? 'minimehfil.wtf'
  );
}
