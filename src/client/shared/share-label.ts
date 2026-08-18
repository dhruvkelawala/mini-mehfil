import { createSignal, onCleanup } from 'solid-js';

/** How long a share button holds its outcome before inviting another copy. */
const SETTLE_MS = 2400;

/**
 * A share button reports what happened and then goes quiet again. Holding
 * "Copied" forever reads as a stuck control, so an outcome fades back to the
 * idle label on its own while an in-flight step waits for its own replacement.
 */
export function createShareLabel(idle = 'Share') {
  const [label, setLabel] = createSignal(idle);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  onCleanup(clear);
  return {
    label,
    /** A step that stays until the next one replaces it, such as "Sharing". */
    hold(value: string) {
      clear();
      setLabel(value);
    },
    /** An outcome that returns to the idle label after a moment. */
    settle(value: string) {
      clear();
      setLabel(value);
      timer = setTimeout(() => setLabel(idle), SETTLE_MS);
    },
    reset() {
      clear();
      setLabel(idle);
    },
  };
}
