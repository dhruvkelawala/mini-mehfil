(function initialiseMediaDiagnostics(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) root.MehfilMediaDiagnostics = api.create(root);
})(typeof window === 'undefined' ? null : window, function mediaDiagnosticsFactory() {
  const PREFIX = '[MEDIA-DIAG-v1]';
  const STORAGE_KEY = 'mini-mehfil:media-diagnostics:v1';
  const MAX_ENTRIES = 200;
  const MEDIA_EVENTS = [
    'loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay',
    'canplaythrough', 'play', 'playing', 'pause', 'waiting', 'stalled',
    'suspend', 'abort', 'error', 'emptied', 'ended'
  ];
  const READY_STATES = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
  const NETWORK_STATES = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'];

  function redactUrl(value, baseUrl) {
    if (typeof value !== 'string' || !value) return value || '';
    try {
      const base = new URL(baseUrl || 'https://mini-mehfil.invalid/');
      const parsed = new URL(value, base);
      if (parsed.origin === base.origin) return parsed.pathname;
      return `${parsed.origin}/[redacted-path]`;
    } catch {
      return '[unparseable-url]';
    }
  }

  function redactText(value, baseUrl) {
    if (typeof value !== 'string') return value;
    return value.replace(/https?:\/\/[^\s"'<>]+/gi, url => redactUrl(url, baseUrl));
  }

  function normalizeError(error, baseUrl) {
    if (!error) return { name: 'Error', message: 'Unknown error' };
    if (typeof error === 'string') return { name: 'Error', message: redactText(error, baseUrl) };
    return {
      name: String(error.name || error.constructor?.name || 'Error'),
      message: redactText(String(error.message || error), baseUrl),
      code: Number.isFinite(error.code) ? error.code : undefined,
      stack: error.stack ? redactText(String(error.stack), baseUrl) : undefined
    };
  }

  function mediaSnapshot(media, baseUrl) {
    if (!media) return null;
    const mediaError = media.error;
    return {
      currentSrc: redactUrl(media.currentSrc || media.src || '', baseUrl),
      paused: Boolean(media.paused),
      ended: Boolean(media.ended),
      seeking: Boolean(media.seeking),
      currentTime: Number.isFinite(media.currentTime) ? Number(media.currentTime.toFixed(3)) : null,
      duration: Number.isFinite(media.duration) ? Number(media.duration.toFixed(3)) : null,
      readyState: `${media.readyState} ${READY_STATES[media.readyState] || 'UNKNOWN'}`,
      networkState: `${media.networkState} ${NETWORK_STATES[media.networkState] || 'UNKNOWN'}`,
      error: mediaError ? {
        code: mediaError.code,
        message: redactText(String(mediaError.message || ''), baseUrl)
      } : null
    };
  }

  function safeDetails(value, baseUrl, key = '') {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (/token|authorization|cookie|lyrics|prompt|payload|requestBody/i.test(key)) return '[redacted]';
    if (value instanceof Error || Object.prototype.toString.call(value) === '[object DOMException]') {
      return normalizeError(value, baseUrl);
    }
    if (typeof value === 'string') return redactText(value, baseUrl);
    if (Array.isArray(value)) return value.map(item => safeDetails(item, baseUrl));
    if (typeof value === 'object') {
      const clean = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        clean[childKey] = safeDetails(childValue, baseUrl, childKey);
      }
      return clean;
    }
    return String(value);
  }

  function create(root) {
    const params = new URLSearchParams(root.location.search);
    const enabled = params.get('mediaDebug') === '1';
    const baseUrl = root.location.href;
    const startedAt = Date.now();
    const sessionId = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let entries = [];
    let fatalState = null;
    let retryHandler = null;
    let panel;
    let output;
    let headline;
    let copyButton;

    function readStoredEntries() {
      try {
        const stored = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || '[]');
        return Array.isArray(stored) ? stored.slice(-MAX_ENTRIES) : [];
      } catch {
        return [];
      }
    }

    function persist() {
      try {
        root.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
      } catch (error) {
        root.console.warn(PREFIX, 'Could not persist diagnostic entries', normalizeError(error, baseUrl));
      }
    }

    function userActivation() {
      return root.navigator.userActivation ? {
        isActive: root.navigator.userActivation.isActive,
        hasBeenActive: root.navigator.userActivation.hasBeenActive
      } : null;
    }

    function environment() {
      return {
        capturedAt: new Date().toISOString(),
        sessionId,
        page: `${root.location.origin}${root.location.pathname}`,
        userAgent: root.navigator.userAgent,
        platform: root.navigator.platform,
        vendor: root.navigator.vendor,
        standalone: Boolean(root.navigator.standalone),
        language: root.navigator.language,
        screen: `${root.screen?.width || 0}x${root.screen?.height || 0}@${root.devicePixelRatio || 1}`,
        viewport: `${root.innerWidth}x${root.innerHeight}`,
        visibilityState: root.document.visibilityState,
        userActivation: userActivation()
      };
    }

    function report() {
      return {
        diagnosticVersion: 1,
        environment: environment(),
        fatal: fatalState,
        entries: entries.slice(-MAX_ENTRIES)
      };
    }

    function updatePanel() {
      if (!panel || !output) return;
      output.textContent = JSON.stringify(report(), null, 2);
      if (fatalState) {
        panel.classList.add('is-fatal');
        headline.textContent = `${fatalState.summary}: ${fatalState.error.name} — ${fatalState.error.message}`;
      }
    }

    function record(type, details = {}) {
      if (!enabled) return null;
      const entry = {
        sequence: entries.length ? entries[entries.length - 1].sequence + 1 : 1,
        sessionId,
        at: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        type,
        details: safeDetails(details, baseUrl)
      };
      entries.push(entry);
      entries = entries.slice(-MAX_ENTRIES);
      persist();
      updatePanel();
      root.console.info(PREFIX, type, entry.details);
      return entry;
    }

    function open() {
      if (!enabled || !panel) return;
      panel.hidden = false;
      updatePanel();
    }

    function fatal(summary, error, media, details = {}) {
      if (!enabled) return;
      fatalState = {
        summary,
        error: normalizeError(error, baseUrl),
        media: mediaSnapshot(media, baseUrl),
        details: safeDetails(details, baseUrl)
      };
      record('fatal', fatalState);
      open();
    }

    async function copyReport() {
      const text = JSON.stringify(report(), null, 2);
      try {
        await root.navigator.clipboard.writeText(text);
        copyButton.textContent = 'Copied';
      } catch (error) {
        record('copy-report-rejected', { error });
        copyButton.textContent = 'Copy failed — download instead';
      }
    }

    function downloadReport() {
      const blob = new Blob([JSON.stringify(report(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = root.document.createElement('a');
      link.href = url;
      link.download = `mini-mehfil-media-${sessionId}.json`;
      root.document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function bindPanel() {
      panel = root.document.querySelector('#media-diagnostics');
      output = root.document.querySelector('#media-diagnostics-output');
      headline = root.document.querySelector('#media-diagnostics-headline');
      copyButton = root.document.querySelector('#media-diagnostics-copy');
      if (!panel) return;
      root.document.querySelector('#media-diagnostics-open').hidden = false;
      root.document.querySelector('#media-diagnostics-open').addEventListener('click', open);
      root.document.querySelector('#media-diagnostics-close').addEventListener('click', () => { panel.hidden = true; });
      copyButton.addEventListener('click', copyReport);
      root.document.querySelector('#media-diagnostics-download').addEventListener('click', downloadReport);
      root.document.querySelector('#media-diagnostics-clear').addEventListener('click', () => {
        entries = [];
        fatalState = null;
        panel.classList.remove('is-fatal');
        headline.textContent = 'Media diagnostics are recording';
        persist();
        record('diagnostics-cleared');
      });
      root.document.querySelector('#media-diagnostics-retry').addEventListener('click', () => {
        record('diagnostic-retry-tapped');
        retryHandler?.();
      });
      updatePanel();
    }

    function attachMedia(media) {
      if (!enabled || !media) return;
      MEDIA_EVENTS.forEach(type => {
        media.addEventListener(type, () => {
          const snapshot = mediaSnapshot(media, baseUrl);
          record(`media:${type}`, snapshot);
          if (type === 'error') {
            const error = media.error || new Error('The audio element emitted an error event without MediaError details.');
            fatal('Audio load or decode failed', error, media, { event: type });
          }
        });
      });
    }

    function setRetryHandler(handler) {
      retryHandler = typeof handler === 'function' ? handler : null;
    }

    if (!enabled) {
      return {
        enabled,
        record() {},
        fatal() {},
        open() {},
        attachMedia() {},
        setRetryHandler() {},
        snapshot: media => mediaSnapshot(media, baseUrl),
        redactUrl: value => redactUrl(value, baseUrl)
      };
    }

    entries = readStoredEntries();
    bindPanel();
    record('session-start', environment());

    root.addEventListener('error', event => {
      fatal('Unhandled window error', event.error || event.message, null, {
        filename: redactUrl(event.filename || '', baseUrl),
        line: event.lineno,
        column: event.colno
      });
    });
    root.addEventListener('unhandledrejection', event => {
      fatal('Unhandled promise rejection', event.reason, null);
    });
    root.addEventListener('pagehide', event => record('pagehide', { persisted: event.persisted }));
    root.addEventListener('pageshow', event => record('pageshow', { persisted: event.persisted }));
    root.addEventListener('beforeunload', () => record('beforeunload'));
    root.document.addEventListener('visibilitychange', () => record('visibilitychange', {
      visibilityState: root.document.visibilityState
    }));
    root.document.addEventListener('freeze', () => record('freeze'));
    root.document.addEventListener('resume', () => record('resume'));

    return {
      enabled,
      record,
      fatal,
      open,
      attachMedia,
      setRetryHandler,
      report,
      snapshot: media => mediaSnapshot(media, baseUrl),
      redactUrl: value => redactUrl(value, baseUrl),
      userActivation
    };
  }

  return { create, redactUrl, redactText, normalizeError, mediaSnapshot, safeDetails };
});
