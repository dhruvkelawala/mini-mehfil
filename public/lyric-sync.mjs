const FAMILY_BY_TAG = new Map([
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
  ['solo', 'inst']
]);

const TIMING_LABELS = new Set([
  'intro', 'verse', 'chorus', 'bridge', 'outro', 'inst', 'silence'
]);

function emptySheet() {
  return { aligned: false, lines: [], sections: [] };
}

function displayLines(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function cueDetails(line) {
  const match = /^\[\s*([^\[\]]+?)\s*\]$/.exec(line);
  if (!match) return null;
  const tag = match[1]
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
  const familyTag = tag.replace(/\s+\d+$/, '');
  return {
    tag,
    family: FAMILY_BY_TAG.get(familyTag) || 'other'
  };
}

function scriptsAlign(primary, secondary) {
  if (!primary.length || primary.length !== secondary.length) return false;
  return primary.every((line, index) => {
    const primaryCue = cueDetails(line);
    const secondaryCue = cueDetails(secondary[index]);
    if (Boolean(primaryCue) !== Boolean(secondaryCue)) return false;
    return !primaryCue || primaryCue.tag === secondaryCue.tag;
  });
}

export function parseLyricSheet(sheet) {
  try {
    if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return emptySheet();
    const native = displayLines(sheet.lyricsNative);
    const roman = displayLines(sheet.lyricsRoman);
    const latin = sheet.isLatinScript === true;
    const primaryLines = latin ? (native.length ? native : roman) : native;
    const aligned = latin ? primaryLines.length > 0 : scriptsAlign(primaryLines, roman);
    const lines = [];
    const sections = [];
    let section = null;

    for (let index = 0; index < primaryLines.length; index += 1) {
      const primary = primaryLines[index];
      const cue = cueDetails(primary);
      if (cue) {
        section = {
          index: sections.length,
          tag: cue.tag,
          family: cue.family,
          lines: []
        };
        sections.push(section);
      } else if (!section) {
        section = {
          index: sections.length,
          tag: null,
          family: 'other',
          lines: []
        };
        sections.push(section);
      }

      const line = {
        cue: Boolean(cue),
        tag: section.tag,
        family: section.family,
        primary,
        secondary: !latin && aligned && !cue && roman[index] !== primary ? roman[index] : '',
        sectionIndex: section.index
      };
      lines.push(line);
      section.lines.push(line);
    }

    return { aligned, lines, sections };
  } catch {
    return emptySheet();
  }
}

export function normalizeLyricTiming(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.version !== 1 || value.mode !== 'minimax-section-asr') return null;
    if (!Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0 || value.durationSeconds > 360) return null;
    if (!Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > 64) return null;

    const segments = [];
    let previousEnd = 0;
    for (const segment of value.segments) {
      if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return null;
      if (!TIMING_LABELS.has(segment.label)) return null;
      if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)) return null;
      if (segment.start < 0 || segment.start >= segment.end || segment.end > value.durationSeconds) return null;
      if (segment.start < previousEnd) return null;
      segments.push({ start: segment.start, end: segment.end, label: segment.label });
      previousEnd = segment.end;
    }

    return {
      version: 1,
      mode: 'minimax-section-asr',
      durationSeconds: value.durationSeconds,
      segments
    };
  } catch {
    return null;
  }
}

export function buildSectionTimeline(sections, timing) {
  try {
    const normalized = normalizeLyricTiming(timing);
    if (!normalized || !Array.isArray(sections)) return null;
    if (!sections.every(section => section
      && typeof section === 'object'
      && !Array.isArray(section)
      && Number.isInteger(section.index)
      && section.index >= 0
      && typeof section.family === 'string')) return null;

    let sectionCursor = 0;
    let mappedCount = 0;
    let timedSectionCount = 0;
    const timeline = normalized.segments.map(segment => {
      let sectionIndex = null;
      if (segment.label !== 'silence') {
        timedSectionCount += 1;
        const match = sections.findIndex((section, index) => (
          index >= sectionCursor && section.family === segment.label
        ));
        if (match !== -1) {
          sectionIndex = sections[match].index;
          sectionCursor = match + 1;
          mappedCount += 1;
        }
      }
      return {
        start: segment.start,
        end: segment.end,
        label: segment.label,
        sectionIndex
      };
    });

    if (mappedCount < 2 || mappedCount * 2 < timedSectionCount) return null;
    return timeline;
  } catch {
    return null;
  }
}

export function activeTimelineEntry(timeline, currentTime) {
  try {
    if (!Number.isFinite(currentTime) || currentTime < 0) return null;
    if (!Array.isArray(timeline) || !timeline.length) return null;
    let previousEnd = 0;
    for (const entry of timeline) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      if (!TIMING_LABELS.has(entry.label)) return null;
      if (!Number.isFinite(entry.start) || !Number.isFinite(entry.end)) return null;
      if (entry.start < 0 || entry.start >= entry.end || entry.start < previousEnd) return null;
      if (entry.sectionIndex !== null && (!Number.isInteger(entry.sectionIndex) || entry.sectionIndex < 0)) return null;
      previousEnd = entry.end;
    }
    return timeline.find(entry => entry.start <= currentTime && currentTime < entry.end) || null;
  } catch {
    return null;
  }
}
