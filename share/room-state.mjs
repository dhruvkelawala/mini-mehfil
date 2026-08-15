export const ROOM_LIMITS = Object.freeze({
  listeners: 20,
  queue: 50,
  name: 40,
  idea: 200,
  vibe: 120,
  language: 40,
  setlist: 100
});

const HOST_EVENTS = new Set([
  'request-accepted', 'request-reordered', 'request-declined',
  'recording-started', 'lyrics-ready', 'recording-failed', 'song-ready',
  'kicked', 'room-expired'
]);

const fail = (state, code) => ({ state, error: { code }, effects: [] });
const ok = (state, effects = []) => ({ state, effects });
const clean = (value, max, required = false) => {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return (!required || text) && text.length <= max ? text : null;
};

export function createRoomState({ roomId, openedAt, expiresAt } = {}) {
  return {
    version: 1,
    roomId,
    openedAt,
    expiresAt,
    expiredAt: null,
    hostPresent: false,
    participants: [],
    kickedParticipantIds: [],
    queue: [],
    currentRecording: null,
    currentSong: null,
    setlist: []
  };
}

export function transitionRoom(state, event) {
  if (!state || !event || typeof event.type !== 'string') return fail(state, 'invalid-event');
  if (state.expiredAt) return fail(state, 'room-expired');
  if (HOST_EVENTS.has(event.type) && event.role !== 'host' && !event.trustedAlarm) return fail(state, 'host-only');
  const next = structuredClone(state);
  const participantIndex = id => next.participants.findIndex(item => item.id === id);
  const requestIndex = id => next.queue.findIndex(item => item.id === id);

  switch (event.type) {
    case 'room-opened':
      return ok(next);
    case 'joined': { 
      if (next.kickedParticipantIds.includes(event.participantId)) return fail(state, 'kicked');
      const existing = participantIndex(event.participantId);
      const name = clean(event.name, ROOM_LIMITS.name);
      if (name === null) return fail(state, 'invalid-name');
      if (event.role === 'host') next.hostPresent = true;
      else if (existing >= 0) {
        next.participants[existing] = { ...next.participants[existing], connected: true, name: name || next.participants[existing].name };
      } else {
        if (next.participants.filter(item => item.connected).length >= ROOM_LIMITS.listeners) return fail(state, 'room-full');
        next.participants.push({ id: event.participantId, name: name || 'Listener', connected: true, joinedAt: event.at });
      }
      return ok(next);
    }
    case 'left': {
      if (event.role === 'host') next.hostPresent = false;
      else {
        const index = participantIndex(event.participantId);
        if (index < 0) return fail(state, 'not-found');
        next.participants[index] = { ...next.participants[index], connected: false };
      }
      return ok(next);
    }
    case 'request-submitted': {
      if (event.role !== 'listener' || event.participantId !== event.actorId) return fail(state, 'listener-only');
      if (participantIndex(event.participantId) < 0) return fail(state, 'not-found');
      if (next.queue.filter(item => !['declined', 'ready'].includes(item.status)).length >= ROOM_LIMITS.queue) return fail(state, 'queue-full');
      const idea = clean(event.idea, ROOM_LIMITS.idea, true);
      const vibe = clean(event.vibe, ROOM_LIMITS.vibe);
      const language = clean(event.language, ROOM_LIMITS.language);
      if (idea === null || vibe === null || language === null) return fail(state, 'invalid-request');
      next.queue.push({ id: event.requestId, participantId: event.participantId, idea, vibe, language, status: 'pending', submittedAt: event.at });
      return ok(next);
    }
    case 'request-accepted': {
      const index = requestIndex(event.requestId);
      if (index < 0 || next.queue[index].status !== 'pending') return fail(state, 'invalid-transition');
      next.queue[index] = { ...next.queue[index], status: 'accepted' };
      return ok(next);
    }
    case 'request-reordered': {
      const from = requestIndex(event.requestId);
      const to = Number(event.toIndex);
      if (from < 0 || !Number.isInteger(to) || to < 0 || to >= next.queue.length || !['pending', 'accepted'].includes(next.queue[from].status)) return fail(state, 'invalid-transition');
      const [item] = next.queue.splice(from, 1);
      next.queue.splice(to, 0, item);
      return ok(next);
    }
    case 'request-declined': {
      const index = requestIndex(event.requestId);
      if (index < 0 || !['pending', 'accepted'].includes(next.queue[index].status)) return fail(state, 'invalid-transition');
      next.queue[index] = { ...next.queue[index], status: 'declined' };
      return ok(next);
    }
    case 'recording-started': {
      if (next.currentRecording) return fail(state, 'recording-active');
      const index = requestIndex(event.requestId);
      if (index < 0 || next.queue[index].status !== 'accepted') return fail(state, 'invalid-transition');
      next.queue[index] = { ...next.queue[index], status: 'recording' };
      next.currentRecording = { requestId: event.requestId, startedAt: event.at, lyrics: null };
      return ok(next);
    }
    case 'lyrics-ready': {
      if (!next.currentRecording || next.currentRecording.requestId !== event.requestId) return fail(state, 'invalid-transition');
      const sheet = event.lyrics || {};
      const allowed = ['title', 'language', 'nativeScriptName', 'isLatinScript', 'lyricsNative', 'lyricsRoman'];
      next.currentRecording.lyrics = Object.fromEntries(allowed.map(key => [key, key === 'isLatinScript' ? Boolean(sheet[key]) : String(sheet[key] || '')]));
      return ok(next);
    }
    case 'recording-failed': {
      if (!next.currentRecording || next.currentRecording.requestId !== event.requestId) return fail(state, 'invalid-transition');
      const index = requestIndex(event.requestId);
      next.queue[index] = { ...next.queue[index], status: 'accepted' };
      next.currentRecording = null;
      return ok(next);
    }
    case 'song-ready': {
      if (!next.currentRecording || next.currentRecording.requestId !== event.requestId || !/^[A-Za-z0-9_-]{16}$/.test(event.shareId || '')) return fail(state, 'invalid-transition');
      if (next.currentSong) next.setlist.push({ shareId: next.currentSong.shareId, title: next.currentSong.title, language: next.currentSong.language, startedAt: next.currentSong.startedAt });
      next.setlist = next.setlist.slice(-ROOM_LIMITS.setlist);
      const sheet = next.currentRecording.lyrics || event.lyrics || {};
      next.currentSong = { shareId: event.shareId, title: String(sheet.title || event.title || ''), language: String(sheet.language || event.language || ''), startedAt: event.startedAt, lyrics: sheet };
      const index = requestIndex(event.requestId);
      next.queue[index] = { ...next.queue[index], status: 'ready' };
      next.currentRecording = null;
      return ok(next);
    }
    case 'kicked': {
      const index = participantIndex(event.participantId);
      if (index < 0) return fail(state, 'not-found');
      next.participants.splice(index, 1);
      if (!next.kickedParticipantIds.includes(event.participantId)) next.kickedParticipantIds.push(event.participantId);
      return ok(next, [{ type: 'close-participant', participantId: event.participantId }]);
    }
    case 'room-expired':
      next.expiredAt = event.at;
      next.hostPresent = false;
      next.participants = next.participants.map(item => ({ ...item, connected: false }));
      return ok(next, [{ type: 'close-all' }]);
    default:
      return fail(state, 'unknown-event');
  }
}

export function projectRoomState(state, viewer = {}) {
  const base = {
    version: state.version,
    roomId: state.roomId,
    openedAt: state.openedAt,
    expiresAt: state.expiresAt,
    expiredAt: state.expiredAt,
    hostPresent: state.hostPresent,
    participants: state.participants.filter(item => item.connected).map(item => viewer.role === 'host' ? { ...item } : { name: item.name }),
    listenerCount: state.participants.filter(item => item.connected).length,
    currentRecording: state.currentRecording ? structuredClone(state.currentRecording) : null,
    currentSong: state.currentSong ? structuredClone(state.currentSong) : null,
    setlist: structuredClone(state.setlist)
  };
  base.queue = viewer.role === 'host'
    ? structuredClone(state.queue)
    : state.queue.map(item => ({ id: item.id, status: item.status, mine: item.participantId === viewer.participantId }));
  return base;
}
