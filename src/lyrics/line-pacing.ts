import type { LyricSection, TimelineEntry } from './lyric-sync.ts';

const VOWEL_GROUP = /[aeiouāēīōūäöü]+/gi;

/** A derived display interval for one spoken lyric line. */
export interface PacedLine {
  sectionIndex: number;
  lineIndexInSection: number;
  start: number;
  end: number;
}

function firstMappedVocalEntry(
  timeline: TimelineEntry[] | null,
): TimelineEntry | null {
  if (!Array.isArray(timeline)) return null;
  return (
    timeline.find(
      (entry) =>
        entry.sectionIndex !== null &&
        entry.label !== 'inst' &&
        entry.label !== 'silence',
    ) ?? null
  );
}

/**
 * Captures the one display origin shared by an asynchronously resolved vocal
 * gate and first-section line pacing. A stale result at/after the section end
 * is discarded because there is no remaining interval in which to show line 1.
 */
export function effectiveFirstVocalRelease(
  timeline: TimelineEntry[] | null,
  detectedGateSeconds: number | null,
  mediaTimeAtResolution: number,
): number | null {
  if (
    !Number.isFinite(detectedGateSeconds) ||
    !Number.isFinite(mediaTimeAtResolution) ||
    mediaTimeAtResolution < 0
  )
    return null;
  const firstVocal = firstMappedVocalEntry(timeline);
  if (
    !firstVocal ||
    !Number.isFinite(firstVocal.start) ||
    !Number.isFinite(firstVocal.end) ||
    firstVocal.start < 0 ||
    firstVocal.start >= firstVocal.end ||
    (detectedGateSeconds as number) < firstVocal.start ||
    (detectedGateSeconds as number) >= firstVocal.end
  )
    return null;
  const release = Math.max(
    detectedGateSeconds as number,
    mediaTimeAtResolution,
  );
  return release < firstVocal.end ? release : null;
}

/**
 * Estimates a romanized line's relative singing weight. This deliberately
 * counts written vowel groups, with a one-beat minimum per whitespace word;
 * it is a pacing heuristic rather than phonetic syllabification.
 */
export function syllableWeight(romanLine: string): number {
  if (typeof romanLine !== 'string') return 0;
  return romanLine
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .reduce((total, word) => {
      const groups = word.match(VOWEL_GROUP)?.length ?? 0;
      return total + Math.max(1, groups);
    }, 0);
}

/**
 * Derives contiguous line intervals inside provider-timed sections. These
 * cues are replaceable at the call site by a future real line-timing source.
 * A valid release rebases only the first mapped vocal section's derived start;
 * the provider timeline and every section end remain untouched.
 */
export function buildLinePacing(
  sections: LyricSection[],
  timeline: TimelineEntry[] | null,
  firstVocalReleaseSeconds: number | null | undefined = null,
): PacedLine[] {
  if (!Array.isArray(sections) || !Array.isArray(timeline)) return [];

  const pacing: PacedLine[] = [];
  const firstVocal = firstMappedVocalEntry(timeline);
  for (const segment of timeline) {
    if (segment.sectionIndex === null) continue;
    const section = sections.find(
      (candidate) => candidate.index === segment.sectionIndex,
    );
    if (!section || !(segment.start < segment.end)) continue;

    const spoken = section.lines
      .map((line, lineIndexInSection) => ({ line, lineIndexInSection }))
      .filter(({ line }) => !line.cue);
    if (!spoken.length) continue;

    const weights = spoken.map(({ line }) =>
      syllableWeight(line.secondary.trim() || line.primary),
    );
    const weightTotal = weights.reduce((total, weight) => total + weight, 0);
    const effectiveWeights = weightTotal ? weights : weights.map(() => 1);
    const effectiveTotal = weightTotal || effectiveWeights.length;
    const rebasedStart =
      segment === firstVocal &&
      Number.isFinite(firstVocalReleaseSeconds) &&
      (firstVocalReleaseSeconds as number) >= segment.start &&
      (firstVocalReleaseSeconds as number) < segment.end
        ? (firstVocalReleaseSeconds as number)
        : segment.start;
    const duration = segment.end - rebasedStart;
    let cursor = rebasedStart;

    spoken.forEach(({ lineIndexInSection }, index) => {
      const start = cursor;
      const end =
        index === spoken.length - 1
          ? segment.end
          : start +
            duration * ((effectiveWeights[index] ?? 0) / effectiveTotal);
      pacing.push({
        sectionIndex: segment.sectionIndex as number,
        lineIndexInSection,
        start,
        end,
      });
      cursor = end;
    });
  }
  return pacing;
}

/** Finds the derived half-open line interval covering the media clock. */
export function activePacedLine(
  pacing: PacedLine[] | null,
  currentTime: number,
): PacedLine | null {
  if (
    !Number.isFinite(currentTime) ||
    currentTime < 0 ||
    !Array.isArray(pacing)
  )
    return null;
  return (
    pacing.find(
      (entry) => entry.start <= currentTime && currentTime < entry.end,
    ) ?? null
  );
}
