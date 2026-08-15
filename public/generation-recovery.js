(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MehfilGenerationRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'mini-mehfil:generation:v1';
  const JOB_PATTERN = /^[A-Za-z0-9_-]{24}$/;
  const TTL_MS = 24 * 60 * 60 * 1000;
  const BACKOFF = [2000, 3000, 5000];
  const SHEET_FIELDS = ['title', 'language', 'languageCode', 'nativeScriptName', 'isLatinScript', 'lyricsNative', 'lyricsRoman', 'prompt'];

  function encodeBase64Url(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }

  function createJobId(cryptoImpl) {
    if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== 'function') throw new Error('Secure randomness is unavailable.');
    const bytes = new Uint8Array(18);
    cryptoImpl.getRandomValues(bytes);
    return encodeBase64Url(bytes);
  }

  function cleanSheet(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const sheet = {};
    for (const field of SHEET_FIELDS) {
      if (field === 'isLatinScript') sheet[field] = Boolean(value[field]);
      else sheet[field] = typeof value[field] === 'string' ? value[field] : '';
    }
    if (!sheet.title || (!sheet.lyricsNative && !sheet.lyricsRoman)) return null;
    return sheet;
  }

  function create(options = {}) {
    const storage = options.storage || null;
    const now = options.now || Date.now;
    const cryptoImpl = options.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    const visibility = options.visibility || (() => typeof document === 'undefined' || document.visibilityState === 'visible');
    const schedule = options.schedule || setTimeout;
    const cancelSchedule = options.cancelSchedule || clearTimeout;
    const fetchStatus = options.fetchStatus || (async jobId => {
      const response = await fetch(`/api/generation-status?id=${encodeURIComponent(jobId)}`);
      const value = await response.json().catch(() => ({ error: 'The server returned an unreadable response.' }));
      return { ok: response.ok, status: response.status, value };
    });
    let active = null;
    let timer = null;
    let inFlight = false;
    let serial = 0;

    function clearTimer() {
      if (timer !== null) cancelSchedule(timer);
      timer = null;
    }

    function remove() {
      try { storage?.removeItem(STORAGE_KEY); } catch {}
    }

    function save(value) {
      const lyricSheet = cleanSheet(value?.lyricSheet);
      if (!storage || !JOB_PATTERN.test(value?.jobId || '') || !lyricSheet) throw new Error('A valid pending generation is required.');
      const record = { version: 1, jobId: value.jobId, createdAt: new Date(now()).toISOString(), lyricSheet };
      storage.setItem(STORAGE_KEY, JSON.stringify(record));
      return record;
    }

    function read() {
      if (!storage) return null;
      let value;
      try { value = JSON.parse(storage.getItem(STORAGE_KEY)); } catch { remove(); return null; }
      const lyricSheet = cleanSheet(value?.lyricSheet);
      const created = Date.parse(value?.createdAt);
      if (value?.version !== 1 || !JOB_PATTERN.test(value?.jobId || '') || !lyricSheet || !Number.isFinite(created) || created + TTL_MS <= now()) {
        remove();
        return null;
      }
      return { version: 1, jobId: value.jobId, createdAt: new Date(created).toISOString(), lyricSheet };
    }

    function stop() {
      clearTimer();
      active = null;
      inFlight = false;
      serial += 1;
    }

    async function poll() {
      timer = null;
      if (!active || inFlight || !visibility()) return;
      const snapshot = active;
      const pollSerial = serial;
      inFlight = true;
      options.onRequest?.(snapshot);
      let response;
      try { response = await fetchStatus(snapshot.jobId); }
      catch (error) { response = { ok: false, status: 0, value: { error: error?.message || 'Network error.' } }; }
      inFlight = false;
      if (!active || active !== snapshot || pollSerial !== serial) return;
      options.onResponse?.(response, snapshot);
      if (!response.ok) {
        if (response.status === 404) {
          stop();
          options.onExpired?.(response.value, snapshot);
        } else {
          options.onRetryable?.({ status: response.status, message: response.value?.error || 'Recording recovery is temporarily unavailable.' }, snapshot);
        }
        return;
      }
      if (response.value?.status === 'complete') {
        stop();
        options.onComplete?.(response.value, snapshot);
        return;
      }
      if (response.value?.status === 'failed') {
        stop();
        options.onFailed?.(response.value, snapshot);
        return;
      }
      options.onPending?.(response.value, snapshot);
      const delay = BACKOFF[Math.min(snapshot.attempt, BACKOFF.length - 1)];
      snapshot.attempt += 1;
      timer = schedule(() => { void poll(); }, delay);
    }

    function start(pending, run) {
      if (!JOB_PATTERN.test(pending?.jobId || '')) return false;
      if (active && active.jobId === pending.jobId && active.run === run) return true;
      stop();
      active = { ...pending, run, attempt: 0 };
      void poll();
      return true;
    }

    function resume() {
      if (active && !inFlight && timer === null) void poll();
    }

    return {
      createJobId: () => createJobId(cryptoImpl),
      save,
      read,
      clear: remove,
      start,
      resume,
      cancel: stop,
      current: () => active
    };
  }

  return { STORAGE_KEY, JOB_PATTERN, createJobId, create };
});
