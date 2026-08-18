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
  /** Name for the still card. The extension decides which apps iOS offers. */
  fileName: string;
  /** Name for the moving card, when the browser can record one. */
  videoFileName: string;
  /** The section the stanza came from, so a clip can play the right words. */
  sectionIndex: number | null;
  stanza: StoryCardLine[];
  backgroundUrl: string;
}

/**
 * One part of the song a story can be about. Choosing one moves the words on
 * the card and the audio in the clip together, so a story can never quote one
 * part while playing another.
 */
export interface StoryPart {
  sectionIndex: number;
  /** The song's own name for it, as written in the sheet. */
  label: string;
  stanza: StoryCardLine[];
}

/** More than this and the card stops being readable in two seconds. */
const STANZA_MAX_LINES = 6;
/** A chorus shorter than this cannot carry the card on its own. */
const CHORUS_MIN_LINES = 3;
const UNNAMED_PART = 'Part';
const RESERVED_FILE_NAME_CHARACTERS = '<>:"/\\|?*';
const FILE_NAME_MAX_LENGTH = 60;

function quoted(line: LyricLine): StoryCardLine {
  return { primary: line.primary, secondary: line.secondary };
}

function sungLines(section: LyricSection): LyricLine[] {
  return section.lines.filter((line) => !line.cue);
}

/**
 * The section the card speaks for: the chorus when the sheet names one long
 * enough to stand alone, otherwise the section with the most sung lines.
 */
export function storyStanzaSection(
  sections: LyricSection[],
): LyricSection | null {
  const chorus = sections.find(
    (section) =>
      section.family === 'chorus' &&
      sungLines(section).length >= CHORUS_MIN_LINES,
  );
  if (chorus) return chorus;
  const sung = sections.filter((section) => sungLines(section).length > 0);
  return sung.length === 0
    ? null
    : sung.reduce((best, next) =>
        sungLines(next).length > sungLines(best).length ? next : best,
      );
}

/**
 * The lines the card quotes. A Story is watched for about two seconds with the
 * sound off, so one stanza beats a scrape of the whole sheet.
 *
 * Falls back to the flat line list for sheets that carry no section cues.
 */
export function storyStanza(
  sections: LyricSection[],
  lines: LyricLine[],
): StoryCardLine[] {
  const chosen = storyStanzaSection(sections);
  if (!chosen)
    return lines
      .filter((line) => !line.cue)
      .slice(0, STANZA_MAX_LINES)
      .map(quoted);
  return sungLines(chosen).slice(0, STANZA_MAX_LINES).map(quoted);
}

/**
 * Every part of the song a story could be about, in the order they are sung.
 *
 * Sections that share a name are numbered, because "Verse" twice tells a
 * person nothing about which one they are choosing. A sheet with no cues has
 * one unnamed part, so the control can still say what it will record.
 */
export function storyParts(sections: LyricSection[]): StoryPart[] {
  const sung = sections.filter((section) => sungLines(section).length > 0);
  if (sung.length === 0) return [];
  const totals = new Map<string, number>();
  for (const section of sung) {
    const name = partName(section);
    totals.set(name, (totals.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const parts = sung.map((section) => {
    const name = partName(section);
    const nth = (seen.get(name) ?? 0) + 1;
    seen.set(name, nth);
    return {
      sectionIndex: section.index,
      label: (totals.get(name) ?? 0) > 1 ? `${name} ${String(nth)}` : name,
      stanza: sungLines(section).slice(0, STANZA_MAX_LINES).map(quoted),
    };
  });
  // A sheet written without cues is one unnamed part, and calling it "Part"
  // tells a person nothing. It is simply the song.
  const only = parts[0];
  if (parts.length === 1 && only && only.label === UNNAMED_PART)
    only.label = 'The song';
  return parts;
}

/** The cue as the sheet wrote it, title-cased; unnamed sections say so. */
function partName(section: LyricSection): string {
  const cue = section.lines.find((line) => line.cue)?.primary.trim();
  if (!cue) return UNNAMED_PART;
  return cue.replace(
    /\w\S*/g,
    (word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase(),
  );
}

/**
 * A name every share sheet and file system accepts. Reserved characters become
 * spaces rather than disappearing, so `Rain/Refrain` stays two readable words.
 *
 * The extension matters: on iOS the share sheet derives the file's type from
 * it, not from the blob's MIME type, and an unknown extension degrades to a
 * type that media-only share targets refuse to open.
 */
export function storyFileName(title: string, extension: string): string {
  let name = '';
  for (const character of title)
    name += RESERVED_FILE_NAME_CHARACTERS.includes(character) ? ' ' : character;
  const trimmed = name.trim().slice(0, FILE_NAME_MAX_LENGTH).trim();
  return `${trimmed || 'Mini Mehfil'}.${extension}`;
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
