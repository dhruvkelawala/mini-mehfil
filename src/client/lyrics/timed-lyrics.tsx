import { For, Show } from 'solid-js';

import type { PacedLine } from '../../lyrics/line-pacing.ts';
import type { LyricLine, LyricSection } from '../../lyrics/lyric-sync.ts';

/** Shared lyric-line markup for host and live-listener timing surfaces. */
export const LyricLineView = (props: {
  line: LyricLine;
  hidden?: boolean;
  current?: boolean;
  upcoming?: boolean;
}) => (
  <span
    classList={{
      'lyric-line': true,
      'lyric-cue': props.line.cue,
      'lyric-line-current': props.current,
      'lyric-line-upcoming': props.upcoming,
    }}
    hidden={props.hidden}
    aria-current={props.current ? 'true' : undefined}
  >
    <Show when={!props.line.cue} fallback={props.line.primary}>
      <span class="lyric-primary">{props.line.primary}</span>
      <Show when={props.line.secondary}>
        <span class="lyric-secondary">{props.line.secondary}</span>
      </Show>
    </Show>
  </span>
);

/** Stable timed-section markup; line emphasis updates without replacing it. */
export const TimedSectionView = (props: {
  section: LyricSection;
  activeLine: PacedLine | null;
  holdLines?: boolean;
}) => (
  <span class="lyric-section lyric-section-current">
    <For
      each={props.section.lines.filter((line) => !props.holdLines || line.cue)}
    >
      {(line, index) => {
        const lineIndex = () => props.section.lines.indexOf(line) ?? index();
        const current = () =>
          !line.cue &&
          props.activeLine?.sectionIndex === props.section.index &&
          props.activeLine.lineIndexInSection === lineIndex();
        const upcoming = () =>
          Boolean(
            !line.cue &&
            props.activeLine &&
            props.activeLine.sectionIndex === props.section.index &&
            lineIndex() > props.activeLine.lineIndexInSection,
          );
        return (
          <LyricLineView
            line={line}
            current={current()}
            upcoming={upcoming()}
          />
        );
      }}
    </For>
  </span>
);
