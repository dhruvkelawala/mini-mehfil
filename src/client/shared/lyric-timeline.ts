import {
  activePacedLine,
  buildLinePacing,
  type PacedLine,
} from '../../lyrics/line-pacing.ts';
import {
  activeTimelineEntry,
  buildSectionTimeline,
  parseLyricSheet,
  type LyricLine,
  type LyricSection,
  type ParsedLyricSheet,
  type TimelineEntry,
} from '../../lyrics/lyric-sync.ts';
import type { JsonValue } from '../../room/primitives.ts';

export interface LyricTimeline {
  sheet: ParsedLyricSheet;
  entries: TimelineEntry[] | null;
}

export type LyricFrame =
  | { kind: 'empty' }
  | { kind: 'rest'; cue: string }
  | {
      kind: 'line';
      cue: string;
      line: LyricLine;
      section: LyricSection;
    }
  | {
      kind: 'section';
      section: LyricSection;
      activeLine: PacedLine | null;
    };

/** Builds the presentation model on top of the canonical synchronization data. */
export function parseLyricTimeline(
  sheet: JsonValue | undefined,
  timing: JsonValue | undefined = null,
): LyricTimeline {
  const parsed = parseLyricSheet(sheet);
  return {
    sheet: parsed,
    entries: buildSectionTimeline(parsed.sections, timing),
  };
}

/** Derives invariant line intervals once for a timeline and vocal release. */
export function buildLyricLinePacing(
  timeline: LyricTimeline,
  firstVocalRelease: number | null | undefined = null,
): PacedLine[] {
  return buildLinePacing(
    timeline.sheet.sections,
    timeline.entries,
    firstVocalRelease,
  );
}

function safeClock(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function cueForSection(section: LyricSection): string {
  return section.lines.find((line) => line.cue)?.primary ?? section.tag ?? '';
}

/**
 * Projects one stateless lyric frame from the media clock. Provider-timed
 * sections win when trusted timing exists; otherwise spoken lines are spread
 * across the first 90% of the recording and the final line is held.
 */
export function lyricFrameAt(
  timeline: LyricTimeline,
  currentTime: number,
  duration: number,
  linePacing: PacedLine[] = [],
): LyricFrame {
  const clock = safeClock(currentTime);
  if (timeline.entries) {
    const timelineEnd =
      timeline.entries.at(-1)?.end ?? Number.POSITIVE_INFINITY;
    const finalMappedEntry = [...timeline.entries]
      .reverse()
      .find((candidate) => candidate.sectionIndex !== null);
    const holdingFinalFrame = clock >= timelineEnd && Boolean(finalMappedEntry);
    const entry =
      activeTimelineEntry(timeline.entries, clock) ??
      (holdingFinalFrame ? finalMappedEntry : undefined);
    if (!entry) return { kind: 'empty' };
    if (entry.sectionIndex === null) {
      if (entry.label === 'inst') return { kind: 'rest', cue: 'Instrumental' };
      if (entry.label === 'silence') return { kind: 'rest', cue: 'Pause' };
      return { kind: 'empty' };
    }
    const section = timeline.sheet.sections.find(
      (candidate) => candidate.index === entry.sectionIndex,
    );
    if (!section) return { kind: 'empty' };
    return {
      kind: 'section',
      section,
      activeLine:
        activePacedLine(linePacing, clock) ??
        (holdingFinalFrame
          ? ([...linePacing]
              .reverse()
              .find(
                (candidate) => candidate.sectionIndex === entry.sectionIndex,
              ) ?? null)
          : null),
    };
  }

  const spoken = timeline.sheet.lines.filter((line) => !line.cue);
  if (!spoken.length) return { kind: 'empty' };
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const progress = safeDuration
    ? Math.min(Math.max(clock / (safeDuration * 0.9), 0), 1)
    : 0;
  const line =
    spoken[Math.min(Math.floor(progress * spoken.length), spoken.length - 1)];
  if (!line) return { kind: 'empty' };
  const section = timeline.sheet.sections.find(
    (candidate) => candidate.index === line.sectionIndex,
  );
  if (!section) return { kind: 'empty' };
  return { kind: 'line', cue: cueForSection(section), line, section };
}
