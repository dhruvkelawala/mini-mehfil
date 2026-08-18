import {
  createEffect,
  createMemo,
  For,
  Match,
  Show,
  Switch,
  type JSX,
} from 'solid-js';

import { LyricLineView } from '../lyrics/timed-lyrics.tsx';
import type { LyricLine, LyricSection } from '../../lyrics/lyric-sync.ts';
import {
  buildLyricLinePacing,
  lyricFrameAt,
  type LyricFrame,
  type LyricTimeline,
} from './lyric-timeline.ts';

import './lyric-performance.css';

export interface LyricPerformanceProps {
  id?: string;
  timeline: LyricTimeline;
  title: string;
  language: string;
  currentTime: number;
  duration: number;
  mode: 'live' | 'transcript';
  firstVocalRelease?: number | null | undefined;
  holdLines?: boolean | undefined;
  status?: JSX.Element;
}

interface SpokenLyric {
  line: LyricLine;
  section: LyricSection;
  lineIndexInSection: number;
}

function cueForSection(section: LyricSection): string {
  return section.lines.find((line) => line.cue)?.primary ?? section.tag ?? '';
}

function approximateShownCount(
  spokenCount: number,
  currentTime: number,
  duration: number,
): number {
  if (!spokenCount) return 0;
  const clock = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0;
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (!safeDuration) return 1;
  const progress = Math.min(clock / (safeDuration * 0.9), 1);
  return Math.max(1, Math.min(spokenCount, Math.ceil(progress * spokenCount)));
}

/** One lyric presentation shared by the host performance and listener room. */
export function LyricPerformance(props: LyricPerformanceProps) {
  let atmosphericScroller: HTMLDivElement | undefined;
  const spoken = createMemo<SpokenLyric[]>(() =>
    props.timeline.sheet.sections.flatMap((section) =>
      section.lines.flatMap((line, lineIndexInSection) =>
        line.cue ? [] : [{ line, section, lineIndexInSection }],
      ),
    ),
  );
  const timed = createMemo(
    () => props.mode === 'live' && Boolean(props.timeline.entries),
  );
  const linePacing = createMemo(() =>
    buildLyricLinePacing(props.timeline, props.firstVocalRelease),
  );
  const frame = createMemo(() =>
    lyricFrameAt(
      props.timeline,
      props.currentTime,
      props.duration,
      linePacing(),
    ),
  );
  const activeSpokenIndex = createMemo(() => {
    if (props.holdLines) return -1;
    const current = frame();
    if (current.kind === 'line')
      return spoken().findIndex((entry) => entry.line === current.line);
    if (current.kind !== 'section' || !current.activeLine) return -1;
    return spoken().findIndex(
      (entry) =>
        entry.section.index === current.activeLine?.sectionIndex &&
        entry.lineIndexInSection === current.activeLine.lineIndexInSection,
    );
  });
  const shownSpokenCount = createMemo(() =>
    props.mode === 'transcript'
      ? spoken().length
      : approximateShownCount(
          spoken().length,
          props.currentTime,
          props.duration,
        ),
  );
  createEffect(() => {
    if (props.mode !== 'live' || timed()) return;
    shownSpokenCount();
    queueMicrotask(() => {
      if (!atmosphericScroller) return;
      if (typeof atmosphericScroller.scrollTo === 'function') {
        atmosphericScroller.scrollTo({
          top: atmosphericScroller.scrollHeight,
          behavior:
            typeof matchMedia === 'function' &&
            matchMedia('(prefers-reduced-motion: reduce)').matches
              ? 'auto'
              : 'smooth',
        });
      } else atmosphericScroller.scrollTop = atmosphericScroller.scrollHeight;
    });
  });

  const focusedFrame = () => {
    if (props.holdLines) return undefined;
    const index = activeSpokenIndex();
    return index >= 0 ? spoken()[index] : undefined;
  };

  return (
    <section
      id={props.id}
      classList={{
        'lyric-performance': true,
        'lyric-performance--timed': timed(),
        'lyric-performance--atmospheric': !timed(),
        'lyric-performance--transcript': props.mode === 'transcript',
      }}
      aria-label={`${props.title} lyric performance`}
    >
      <header class="lyric-performance__header">
        <h2 class="lyric-performance__title">{props.title}</h2>
        <p class="lyric-performance__language">{props.language}</p>
      </header>
      <Show when={props.status}>
        <div class="lyric-performance__status">{props.status}</div>
      </Show>

      <Switch>
        <Match when={timed()}>
          <div
            class="lyric-performance__body lyric-performance__focus"
            aria-live="polite"
            aria-atomic="true"
          >
            <Switch
              fallback={
                <span class="lyric-performance__empty" aria-hidden="true" />
              }
            >
              <Match when={focusedFrame()}>
                {(current) => {
                  const index = () => activeSpokenIndex();
                  return (
                    <div class="lyric-performance__focus-frame lyric-section lyric-section-current">
                      <p class="lyric-performance__section-cue lyric-cue">
                        {cueForSection(current().section)}
                      </p>
                      <Show when={spoken()[index() - 1]?.line}>
                        {(line) => (
                          <div class="lyric-performance__context lyric-performance__context--previous">
                            <LyricLineView line={line()} />
                          </div>
                        )}
                      </Show>
                      <div class="lyric-performance__current">
                        <LyricLineView line={current().line} current />
                      </div>
                      <Show when={spoken()[index() + 1]?.line}>
                        {(line) => (
                          <div class="lyric-performance__context lyric-performance__context--next">
                            <LyricLineView line={line()} />
                          </div>
                        )}
                      </Show>
                    </div>
                  );
                }}
              </Match>
              <Match
                when={
                  frame().kind === 'section'
                    ? (frame() as Extract<LyricFrame, { kind: 'section' }>)
                    : undefined
                }
              >
                {(current) => (
                  <p class="lyric-performance__section-cue lyric-cue">
                    {cueForSection(current().section)}
                  </p>
                )}
              </Match>
              <Match
                when={
                  frame().kind === 'rest'
                    ? (frame() as Extract<LyricFrame, { kind: 'rest' }>)
                    : undefined
                }
              >
                {(current) => (
                  <p class="lyric-performance__section-cue lyric-cue">
                    {current().cue}
                  </p>
                )}
              </Match>
            </Switch>
          </div>
        </Match>
        <Match when={!timed()}>
          <div
            ref={(element) => {
              atmosphericScroller = element;
            }}
            class="lyric-performance__body lyric-performance__atmospheric"
            aria-live={props.mode === 'live' ? 'polite' : undefined}
            aria-label={
              props.mode === 'live' ? 'Lyrics revealed so far' : 'Lyrics'
            }
          >
            <For each={props.timeline.sheet.sections}>
              {(section) => {
                const lines = section.lines.filter((line) => !line.cue);
                const firstIndex = () =>
                  spoken().findIndex((entry) => entry.section === section);
                const visible = () =>
                  firstIndex() >= 0 && firstIndex() < shownSpokenCount();
                return (
                  <section
                    class="lyric-performance__section lyric-section"
                    hidden={!visible()}
                  >
                    <h3 class="lyric-cue">{cueForSection(section)}</h3>
                    <For each={lines}>
                      {(line, index) => (
                        <LyricLineView
                          line={line}
                          hidden={firstIndex() + index() >= shownSpokenCount()}
                        />
                      )}
                    </For>
                  </section>
                );
              }}
            </For>
          </div>
        </Match>
      </Switch>
    </section>
  );
}
