import { createMemo, For, Match, Show, Switch, type JSX } from 'solid-js';

import { LyricLineView, TimedSectionView } from '../lyrics/timed-lyrics.tsx';
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

const activeSectionIndex = (frame: LyricFrame): number | null => {
  if (frame.kind === 'line' || frame.kind === 'section')
    return frame.section.index;
  return null;
};

/** One lyric presentation shared by the host performance and listener room. */
export function LyricPerformance(props: LyricPerformanceProps) {
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

  return (
    <section
      id={props.id}
      classList={{
        'lyric-performance': true,
        'lyric-performance--live': props.mode === 'live',
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

      <Show
        when={props.mode === 'transcript'}
        fallback={
          <div
            class="lyric-performance__body lyric-performance__live"
            aria-live="polite"
            aria-atomic="true"
          >
            <Switch
              fallback={
                <span class="lyric-performance__empty" aria-hidden="true" />
              }
            >
              <Match
                when={
                  frame().kind === 'line'
                    ? (frame() as Extract<LyricFrame, { kind: 'line' }>)
                    : undefined
                }
              >
                {(current) => (
                  <div class="lyric-performance__frame">
                    <Show when={current().cue}>
                      <p class="lyric-line lyric-cue">{current().cue}</p>
                    </Show>
                    <p
                      class="lyric-line lyric-line-current"
                      aria-current="true"
                    >
                      <span class="lyric-primary">
                        {current().line.primary}
                      </span>
                      <Show when={current().line.secondary}>
                        <span class="lyric-secondary">
                          {current().line.secondary}
                        </span>
                      </Show>
                    </p>
                  </div>
                )}
              </Match>
              <Match
                when={
                  frame().kind === 'section'
                    ? (frame() as Extract<LyricFrame, { kind: 'section' }>)
                    : undefined
                }
              >
                {(current) => (
                  <TimedSectionView
                    section={current().section}
                    activeLine={current().activeLine}
                    holdLines={Boolean(props.holdLines)}
                  />
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
                  <p class="lyric-line lyric-cue">{current().cue}</p>
                )}
              </Match>
            </Switch>
          </div>
        }
      >
        <div class="lyric-performance__body lyric-performance__transcript">
          <For each={props.timeline.sheet.sections}>
            {(section) => {
              const current = () =>
                activeSectionIndex(frame()) === section.index;
              return (
                <span
                  classList={{
                    'lyric-section': true,
                    'lyric-section-current': current(),
                  }}
                  aria-current={current() ? 'true' : undefined}
                >
                  <For each={section.lines}>
                    {(line) => <LyricLineView line={line} />}
                  </For>
                </span>
              );
            }}
          </For>
        </div>
      </Show>
    </section>
  );
}
