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

interface ScriptSection {
  cue: string | null;
  spoken: string[];
}

function scriptSections(value: unknown): ScriptSection[] {
  if (typeof value !== 'string') return [];
  const sections: ScriptSection[] = [];
  let current: ScriptSection | null = null;
  for (const sourceLine of value.split('\n')) {
    const line = sourceLine.trim();
    if (!line) continue;
    const cue = line.match(/^\[(.+)\]$/)?.[1]?.trim();
    if (cue) {
      current = { cue, spoken: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { cue: null, spoken: [] };
      sections.push(current);
    }
    current.spoken.push(line);
  }
  return sections;
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
 * Non-Latin sheets align native and romanized text inside section boundaries,
 * so an omitted companion line cannot turn the next bracketed cue into sung
 * text. Romanized cue wording remains preferred while native text remains the
 * primary sung line whenever it is available.
 */
export function parseLyricSheet(sheet: unknown): ParsedLyricSheet {
  const empty: ParsedLyricSheet = { lines: [], sections: [] };
  try {
    if (!isRecord(sheet)) return empty;
    const roman = scriptSections(sheet.lyricsRoman);
    const native = scriptSections(sheet.lyricsNative);
    const useNative = sheet.isLatinScript !== true && native.length > 0;
    const lines: LyricLine[] = [];
    const sections: LyricSection[] = [];
    const primarySections = useNative ? native : roman.length ? roman : native;
    const sectionCount = useNative
      ? Math.max(primarySections.length, roman.length)
      : primarySections.length;

    for (let index = 0; index < sectionCount; index += 1) {
      const primarySection = primarySections[index];
      const romanSection = roman[index];
      const cue = romanSection?.cue ?? primarySection?.cue ?? null;
      const details = cue
        ? cueDetails(cue)
        : { tag: null, family: 'other' as const };
      const section: LyricSection = {
        index,
        tag: details.tag,
        family: details.family,
        lines: [],
      };
      sections.push(section);

      if (cue) {
        const cueLine: LyricLine = {
          cue: true,
          tag: section.tag,
          family: section.family,
          primary: cue,
          secondary: '',
          sectionIndex: section.index,
        };
        lines.push(cueLine);
        section.lines.push(cueLine);
      }

      const primarySpoken = primarySection?.spoken ?? [];
      const romanSpoken = romanSection?.spoken ?? [];
      const spokenCount = useNative
        ? Math.max(primarySpoken.length, romanSpoken.length)
        : primarySpoken.length;
      for (let spokenIndex = 0; spokenIndex < spokenCount; spokenIndex += 1) {
        const nativeLine = primarySpoken[spokenIndex] ?? '';
        const romanLine = useNative ? (romanSpoken[spokenIndex] ?? '') : '';
        const primary = nativeLine || romanLine;
        if (!primary) continue;
        const line: LyricLine = {
          cue: false,
          tag: section.tag,
          family: section.family,
          primary,
          secondary:
            nativeLine && romanLine && romanLine !== nativeLine
              ? romanLine
              : '',
          sectionIndex: section.index,
        };
        lines.push(line);
        section.lines.push(line);
      }
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
 * Maps timing segments onto written sections by family — never by the
 * provider's transcribed text. The match is an order-preserving alignment
 * that maximizes how many written sections pair with provider segments, so
 * one early cross-family coincidence cannot leap past the rest of the sheet.
 * The provider often splits or repeats a sung section (two chorus segments
 * for one written chorus, a final repeated chorus); segments left unmatched
 * by the alignment inherit the nearest matched section of the same family,
 * so repeats show the words they repeat instead of an empty stage.
 *
 * Returns `null` when the alignment is too weak to trust: fewer than two
 * matched segments, or fewer than half of the non-silence segments matched.
 * Inherited repeats never count toward that confidence.
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

    const sung = normalized.segments
      .map((segment, position) => ({ label: segment.label, position }))
      .filter((segment) => segment.label !== 'silence');

    // best[i][j] is the largest number of order-preserving family matches
    // between sung segments i.. and written sections j.. .
    const best = Array.from({ length: sung.length + 1 }, () =>
      new Array<number>(parsed.length + 1).fill(0),
    );
    for (let i = sung.length - 1; i >= 0; i -= 1) {
      for (let j = parsed.length - 1; j >= 0; j -= 1) {
        let candidate = Math.max(best[i + 1]![j]!, best[i]![j + 1]!);
        if (sung[i]!.label === parsed[j]!.family)
          candidate = Math.max(candidate, 1 + best[i + 1]![j + 1]!);
        best[i]![j] = candidate;
      }
    }

    const assigned = new Array<number | null>(normalized.segments.length).fill(
      null,
    );
    let firstAnchor = Number.POSITIVE_INFINITY;
    for (let i = 0, j = 0; i < sung.length && j < parsed.length;) {
      if (
        sung[i]!.label === parsed[j]!.family &&
        best[i]![j] === 1 + best[i + 1]![j + 1]!
      ) {
        assigned[sung[i]!.position] = parsed[j]!.index;
        if (sung[i]!.position < firstAnchor) firstAnchor = sung[i]!.position;
        i += 1;
        j += 1;
      } else if (best[i + 1]![j]! >= best[i]![j + 1]!) {
        i += 1;
      } else {
        j += 1;
      }
    }

    const mappedCount = best[0]![0]!;
    if (mappedCount < 2 || mappedCount * 2 < sung.length) return null;

    // Lyrics are sung verbatim, so a written section the alignment could not
    // match was still sung somewhere between its neighbors. When exactly one
    // unmatched sung segment sits between two aligned segments whose sections
    // sandwich exactly one unmatched written section, pair them positionally
    // even though the provider used a different label for it.
    for (let at = 1; at < sung.length - 1; at += 1) {
      const position = sung[at]!.position;
      if (assigned[position] !== null) continue;
      const before = assigned[sung[at - 1]!.position] ?? null;
      const after = assigned[sung[at + 1]!.position] ?? null;
      if (before === null || after === null || after - before !== 2) continue;
      assigned[position] = before + 1;
    }

    // Unmatched sung segments are provider splits or repeats: give them the
    // nearest matched section of the same family, looking back then ahead.
    // Segments before the first anchor never inherit — with no earlier match
    // there is no evidence the written sheet has started, and a mislabeled
    // opening (an instrumental heard as 'chorus') must not display words.
    const lastByFamily = new Map<string, number>();
    for (const { label, position } of sung) {
      const index = assigned[position] ?? null;
      if (index !== null) lastByFamily.set(label, index);
      else if (lastByFamily.has(label))
        assigned[position] = lastByFamily.get(label)!;
    }
    const nextByFamily = new Map<string, number>();
    for (let at = sung.length - 1; at >= 0; at -= 1) {
      const { label, position } = sung[at]!;
      const index = assigned[position] ?? null;
      if (index !== null) nextByFamily.set(label, index);
      else if (position > firstAnchor && nextByFamily.has(label))
        assigned[position] = nextByFamily.get(label)!;
    }

    return normalized.segments.map((segment, position) => ({
      start: segment.start,
      end: segment.end,
      label: segment.label,
      sectionIndex: assigned[position] ?? null,
    }));
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
