/**
 * Section-level lyric synchronization shared by the host app, the Node server,
 * and the Worker's shared playback page.
 *
 * The timing artifact this module validates is immutable provider-derived data
 * tied to one recording. New providers or finer-grained sources must arrive as
 * a new `mode`/`version` pair rather than by mutating `minimax-section-asr`.
 */

const FAMILY_BY_TAG = new Map<string, SectionFamily>([
  ['intro', 'intro'],
  ['verse', 'verse'],
  ['pre chorus', 'verse'],
  ['chorus', 'chorus'],
  ['post chorus', 'chorus'],
  ['hook', 'chorus'],
  ['bridge', 'bridge'],
  ['transition', 'bridge'],
  ['build up', 'bridge'],
  ['break', 'bridge'],
  ['outro', 'outro'],
  ['interlude', 'inst'],
  ['inst', 'inst'],
  ['solo', 'inst'],
]);

const TIMING_LABELS = new Set<string>([
  'intro',
  'verse',
  'chorus',
  'bridge',
  'outro',
  'inst',
  'silence',
]);

const MAX_TIMING_DURATION_SECONDS = 360;
const MAX_TIMING_SEGMENTS = 64;
// MiniMax rounds segment boundaries but reports the exact duration, so its
// own final boundary can overshoot its own duration by a few milliseconds.
// Boundaries within this tolerance are clamped to the duration instead of
// voiding the whole artifact; larger overshoots stay rejected.
const MAX_TIMING_END_OVERSHOOT_SECONDS = 1;

/** Segment labels MiniMax section analysis may report. */
export type TimingLabel =
  'intro' | 'verse' | 'chorus' | 'bridge' | 'outro' | 'inst' | 'silence';

/**
 * Timing family a written lyric section belongs to. `other` never matches a
 * segment label, so unrecognised cues stay unmapped instead of guessing.
 */
export type SectionFamily =
  'intro' | 'verse' | 'chorus' | 'bridge' | 'outro' | 'inst' | 'other';

export interface LyricSheetInput {
  isLatinScript?: boolean;
  lyricsNative?: string;
  lyricsRoman?: string;
}

export interface LyricLine {
  /** True for a bracketed section cue such as `[Chorus]`. */
  cue: boolean;
  /** Normalized cue tag of the owning section, or `null` for an implicit one. */
  tag: string | null;
  family: SectionFamily;
  /** Display text: cue text without brackets, or the sung line. */
  primary: string;
  /** Romanized companion line, or `''` when there is nothing to show. */
  secondary: string;
  sectionIndex: number;
}

export interface LyricSection {
  index: number;
  tag: string | null;
  family: SectionFamily;
  lines: LyricLine[];
}

export interface ParsedLyricSheet {
  lines: LyricLine[];
  sections: LyricSection[];
}

export interface LyricTimingSegment {
  start: number;
  end: number;
  label: TimingLabel;
}

export interface LyricTiming {
  version: 1;
  mode: 'minimax-section-asr';
  durationSeconds: number;
  segments: LyricTimingSegment[];
}

export interface TimelineEntry {
  start: number;
  end: number;
  label: TimingLabel;
  /** Index into the parsed sections, or `null` when nothing maps. */
  sectionIndex: number | null;
}

/**
 * MiniMax Music 3 may return finer section names such as `pre-chorus` even
 * though the public timing contract stores only the stable display families.
 */
function normalizedTimingLabel(value: unknown): TimingLabel | null {
  if (typeof value !== 'string') return null;
  const tag = value
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (tag === 'pre chorus') return 'verse';
  return TIMING_LABELS.has(tag) ? (tag as TimingLabel) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayLines(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split('\n').filter((line) => line.trim());
}

/**
 * Normalizes a cue's bracket-free text into a tag and its timing family.
 * `[Pre-Chorus 2]` becomes tag `pre chorus 2` in family `verse`.
 */
function cueDetails(text: string): { tag: string; family: SectionFamily } {
  const tag = text
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
  const familyTag = tag.replace(/\s+\d+$/, '');
  return { tag, family: FAMILY_BY_TAG.get(familyTag) ?? 'other' };
}

/**
 * Splits a lyric sheet into display lines and the sections they belong to.
 *
 * The display semantics deliberately match the host app's original reveal: the
 * romanized sheet decides whether a line is a cue and supplies the cue text,
 * while non-Latin songs show the native line as `primary` and the romanized
 * line as `secondary`.
 */
export function parseLyricSheet(sheet: unknown): ParsedLyricSheet {
  const empty: ParsedLyricSheet = { lines: [], sections: [] };
  try {
    if (!isRecord(sheet)) return empty;
    const roman = displayLines(sheet.lyricsRoman);
    const native = displayLines(sheet.lyricsNative);
    const useNative = sheet.isLatinScript !== true && native.length > 0;
    const source = useNative ? native : roman;

    const lines: LyricLine[] = [];
    const sections: LyricSection[] = [];
    let section: LyricSection | null = null;

    for (let index = 0; index < source.length; index += 1) {
      const sourceLine = source[index] ?? '';
      const romanLine = roman[index] ?? '';
      const cueSource = romanLine || sourceLine;
      const cue = /^\[.+\]$/.test(cueSource);
      const primary = cue ? cueSource.replace(/^\[(.+)\]$/, '$1') : sourceLine;

      if (cue) {
        const details = cueDetails(primary);
        section = {
          index: sections.length,
          tag: details.tag,
          family: details.family,
          lines: [],
        };
        sections.push(section);
      } else if (!section) {
        section = {
          index: sections.length,
          tag: null,
          family: 'other',
          lines: [],
        };
        sections.push(section);
      }

      const line: LyricLine = {
        cue,
        tag: section.tag,
        family: section.family,
        primary,
        secondary:
          useNative && !cue && romanLine !== sourceLine ? romanLine : '',
        sectionIndex: section.index,
      };
      lines.push(line);
      section.lines.push(line);
    }

    return { lines, sections };
  } catch {
    return empty;
  }
}

/**
 * Validates an untrusted timing artifact and returns a freshly allocated copy
 * with unknown properties stripped, or `null` when anything is out of contract.
 */
export function normalizeLyricTiming(value: unknown): LyricTiming | null {
  try {
    if (!isRecord(value)) return null;
    if (value.version !== 1 || value.mode !== 'minimax-section-asr')
      return null;
    const durationSeconds = value.durationSeconds;
    if (
      typeof durationSeconds !== 'number' ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > MAX_TIMING_DURATION_SECONDS
    )
      return null;
    if (
      !Array.isArray(value.segments) ||
      value.segments.length < 1 ||
      value.segments.length > MAX_TIMING_SEGMENTS
    )
      return null;

    const segments: LyricTimingSegment[] = [];
    let previousEnd = 0;
    for (const candidate of value.segments as unknown[]) {
      if (!isRecord(candidate)) return null;
      const { start, end } = candidate;
      const label = normalizedTimingLabel(candidate.label);
      if (!label) return null;
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isFinite(start) ||
        !Number.isFinite(end)
      )
        return null;
      let boundedEnd = end;
      if (end > durationSeconds) {
        if (end - durationSeconds > MAX_TIMING_END_OVERSHOOT_SECONDS)
          return null;
        boundedEnd = durationSeconds;
      }
      if (start < 0 || start >= boundedEnd) return null;
      if (start < previousEnd) return null;
      segments.push({ start, end: boundedEnd, label });
      previousEnd = boundedEnd;
    }

    return {
      version: 1,
      mode: 'minimax-section-asr',
      durationSeconds,
      segments,
    };
  } catch {
    return null;
  }
}

/**
 * Maps timing segments onto written sections by family in occurrence order —
 * never by the provider's transcribed text.
 *
 * Returns `null` when the mapping is too weak to trust: fewer than two mapped
 * segments, or fewer than half of the non-silence segments mapped.
 *
 * Both arguments are `unknown` because they can arrive from stored JSON.
 */
export function buildSectionTimeline(
  sections: unknown,
  timing: unknown,
): TimelineEntry[] | null {
  try {
    const normalized = normalizeLyricTiming(timing);
    if (!normalized || !Array.isArray(sections)) return null;
    const candidates = sections as unknown[];
    if (
      !candidates.every(
        (section) =>
          isRecord(section) &&
          Number.isInteger(section.index) &&
          typeof section.index === 'number' &&
          section.index >= 0 &&
          typeof section.family === 'string',
      )
    )
      return null;
    const parsed = candidates as unknown as LyricSection[];

    let sectionCursor = 0;
    let mappedCount = 0;
    let timedSectionCount = 0;
    const timeline = normalized.segments.map((segment): TimelineEntry => {
      let sectionIndex: number | null = null;
      if (segment.label !== 'silence') {
        timedSectionCount += 1;
        const match = parsed.findIndex(
          (section, index) =>
            index >= sectionCursor && section.family === segment.label,
        );
        const matched = match === -1 ? undefined : parsed[match];
        if (matched) {
          sectionIndex = matched.index;
          sectionCursor = match + 1;
          mappedCount += 1;
        }
      }
      return {
        start: segment.start,
        end: segment.end,
        label: segment.label,
        sectionIndex,
      };
    });

    if (mappedCount < 2 || mappedCount * 2 < timedSectionCount) return null;
    return timeline;
  } catch {
    return null;
  }
}

/**
 * Finds the half-open `[start, end)` entry covering `currentTime`.
 *
 * Every lookup is stateless, so a backward seek behaves exactly like a fresh
 * forward one and no cursor can drift out of sync with the media clock.
 */
export function activeTimelineEntry(
  timeline: unknown,
  currentTime: number,
): TimelineEntry | null {
  try {
    if (!Number.isFinite(currentTime) || currentTime < 0) return null;
    if (!Array.isArray(timeline) || !timeline.length) return null;
    const entries = timeline as unknown[];
    let previousEnd = 0;
    for (const entry of entries) {
      if (!isRecord(entry)) return null;
      const { start, end, label, sectionIndex } = entry;
      if (typeof label !== 'string' || !TIMING_LABELS.has(label)) return null;
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isFinite(start) ||
        !Number.isFinite(end)
      )
        return null;
      if (start < 0 || start >= end || start < previousEnd) return null;
      if (
        sectionIndex !== null &&
        (!Number.isInteger(sectionIndex) ||
          typeof sectionIndex !== 'number' ||
          sectionIndex < 0)
      )
        return null;
      previousEnd = end;
    }
    return (
      (entries as TimelineEntry[]).find(
        (entry) => entry.start <= currentTime && currentTime < entry.end,
      ) ?? null
    );
  } catch {
    return null;
  }
}
