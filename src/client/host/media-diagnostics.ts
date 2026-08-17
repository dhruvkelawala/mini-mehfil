import { createSignal } from 'solid-js';

export interface MediaDiagnostics {
  visible: () => boolean;
  headline: () => string;
  report: () => string;
  recordFailure(error: unknown): void;
  close(): void;
}

export function createMediaDiagnostics(): MediaDiagnostics {
  const [visible, setVisible] = createSignal(false);
  const [headline, setHeadline] = createSignal(
    'Media diagnostics are recording',
  );
  const [report, setReport] = createSignal('');
  return {
    visible,
    headline,
    report,
    recordFailure(error) {
      const message =
        error instanceof Error ? error.message : 'Playback was rejected.';
      setHeadline('Playback stopped for evidence');
      setReport(
        JSON.stringify({ type: 'playback-rejected', message }, null, 2),
      );
      setVisible(true);
    },
    close: () => setVisible(false),
  };
}
