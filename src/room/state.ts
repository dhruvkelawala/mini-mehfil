import type {
  LyricsSheet,
  RoomEffect,
  RoomErrorCode,
  RoomEvent,
  RoomState,
  SetlistSong,
  TransitionResult,
} from './protocol.ts';
import { isRecord } from './protocol.ts';
import { isString, type JsonValue } from './primitives.ts';
import { normalizeLyricTiming } from '../lyrics/lyric-sync.ts';

export const ROOM_LIMITS = Object.freeze({
  listeners: 20,
  queue: 50,
  name: 40,
  idea: 200,
  vibe: 120,
  language: 40,
  setlist: 100,
});

const HOST_EVENTS = new Set<RoomEvent['type']>([
  'request-accepted',
  'request-reordered',
  'request-declined',
  'recording-enqueued',
  'recording-reordered',
  'recording-removed',
  'recording-started',
  'lyrics-ready',
  'recording-failed',
  'song-ready',
  'song-shared',
  'song-selected',
  'playback-updated',
  'kicked',
  'room-expired',
]);

const fail = (state: RoomState, code: RoomErrorCode): TransitionResult => ({
  state,
  error: { code },
  effects: [],
});
const ok = (
  state: RoomState,
  effects: RoomEffect[] = [],
): TransitionResult => ({
  state,
  effects,
});
const clean = (
  value: JsonValue | undefined,
  max: number,
  required = false,
): string | null => {
  const text = isString(value) ? value.trim().replace(/\s+/g, ' ') : '';
  return (!required || text) && text.length <= max ? text : null;
};

function cleanLyrics(sheet: JsonValue | undefined): LyricsSheet | null {
  if (!isRecord(sheet)) return null;
  const title = clean(sheet.title, 120, true);
  const language = clean(sheet.language, 80, true);
  const nativeScriptName = clean(sheet.nativeScriptName, 80);
  const lyricsNativeRaw = sheet.lyricsNative;
  const lyricsNative =
    isString(lyricsNativeRaw) &&
    lyricsNativeRaw.trim() &&
    lyricsNativeRaw.length <= 5000
      ? lyricsNativeRaw
      : null;
  const lyricsRomanRaw = sheet.lyricsRoman;
  const lyricsRoman =
    isString(lyricsRomanRaw) &&
    lyricsRomanRaw.trim() &&
    lyricsRomanRaw.length <= 5000
      ? lyricsRomanRaw
      : null;
  if (
    title === null ||
    language === null ||
    nativeScriptName === null ||
    lyricsNative === null ||
    lyricsRoman === null
  ) {
    return null;
  }
  return {
    title,
    language,
    nativeScriptName,
    isLatinScript: Boolean(sheet.isLatinScript),
    lyricsNative,
    lyricsRoman,
  };
}

export function createRoomState({
  roomId,
  openedAt,
  expiresAt,
}: {
  roomId: string;
  openedAt: number;
  expiresAt: number;
}): RoomState {
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
    recordingQueue: [],
    currentRecording: null,
    currentSong: null,
    setlist: [],
  };
}

export function transitionRoom(
  state: RoomState,
  event: RoomEvent,
): TransitionResult {
  if (state.expiredAt) return fail(state, 'room-expired');
  if (
    HOST_EVENTS.has(event.type) &&
    event.role !== 'host' &&
    !event.trustedAlarm
  ) {
    return fail(state, 'host-only');
  }
  const participantIndex = (id: string) =>
    state.participants.findIndex((item) => item.id === id);
  const requestIndex = (id: string) =>
    state.queue.findIndex((item) => item.id === id);

  switch (event.type) {
    case 'room-opened':
      return ok(structuredClone(state));
    case 'joined': {
      if (state.kickedParticipantIds.includes(event.participantId)) {
        return fail(state, 'kicked');
      }
      const existing = participantIndex(event.participantId);
      const name = clean(event.name, ROOM_LIMITS.name);
      if (name === null) return fail(state, 'invalid-name');
      if (
        event.role !== 'host' &&
        existing < 0 &&
        state.participants.filter((item) => item.connected).length >=
          ROOM_LIMITS.listeners
      ) {
        return fail(state, 'room-full');
      }
      const next = structuredClone(state);
      if (event.role === 'host') next.hostPresent = true;
      else if (existing >= 0) {
        const participant = next.participants[existing];
        if (!participant) return fail(state, 'not-found');
        next.participants[existing] = {
          ...participant,
          connected: true,
          name: name || participant.name,
        };
      } else {
        next.participants.push({
          id: event.participantId,
          name: name || 'Listener',
          connected: true,
          joinedAt: event.at,
        });
      }
      return ok(next);
    }
    case 'left': {
      const index = participantIndex(event.participantId);
      if (event.role !== 'host' && index < 0) return fail(state, 'not-found');
      const next = structuredClone(state);
      if (event.role === 'host') next.hostPresent = false;
      else {
        const participant = next.participants[index];
        if (!participant) return fail(state, 'not-found');
        next.participants[index] = { ...participant, connected: false };
      }
      return ok(next);
    }
    case 'request-submitted': {
      if (event.role !== 'listener' || event.participantId !== event.actorId) {
        return fail(state, 'listener-only');
      }
      if (participantIndex(event.participantId) < 0) {
        return fail(state, 'not-found');
      }
      const activeRequestCount = state.queue.filter(
        (item) => !['declined', 'ready'].includes(item.status),
      ).length;
      if (activeRequestCount >= ROOM_LIMITS.queue) {
        return fail(state, 'queue-full');
      }
      const idea = clean(event.idea, ROOM_LIMITS.idea, true);
      const vibe = clean(event.vibe, ROOM_LIMITS.vibe);
      const language = clean(event.language, ROOM_LIMITS.language);
      if (idea === null || vibe === null || language === null) {
        return fail(state, 'invalid-request');
      }
      const next = structuredClone(state);
      next.queue.push({
        id: event.requestId,
        participantId: event.participantId,
        idea,
        vibe,
        language,
        status: 'pending',
        submittedAt: event.at,
      });
      return ok(next);
    }
    case 'request-accepted': {
      const index = requestIndex(event.requestId);
      const request = state.queue[index];
      if (!request || request.status !== 'pending') {
        return fail(state, 'invalid-transition');
      }
      const next = structuredClone(state);
      next.queue[index] = { ...request, status: 'accepted' };
      return ok(next);
    }
    case 'request-reordered': {
      const from = requestIndex(event.requestId);
      const request = state.queue[from];
      const invalidTarget =
        !Number.isInteger(event.toIndex) ||
        event.toIndex < 0 ||
        event.toIndex >= state.queue.length;
      const movable =
        request !== undefined &&
        ['pending', 'accepted'].includes(request.status);
      if (invalidTarget || !movable) return fail(state, 'invalid-transition');
      const next = structuredClone(state);
      const [item] = next.queue.splice(from, 1);
      if (!item) return fail(state, 'invalid-transition');
      next.queue.splice(event.toIndex, 0, item);
      return ok(next);
    }
    case 'request-declined': {
      const index = requestIndex(event.requestId);
      const request = state.queue[index];
      if (!request || !['pending', 'accepted'].includes(request.status)) {
        return fail(state, 'invalid-transition');
      }
      const next = structuredClone(state);
      next.queue[index] = { ...request, status: 'declined' };
      return ok(next);
    }
    case 'recording-enqueued': {
      const index = requestIndex(event.requestId);
      const request = state.queue[index];
      if (!request) return fail(state, 'not-found');
      if (
        request.status === 'queued' ||
        request.status === 'recording' ||
        request.status === 'ready'
      ) {
        return ok(structuredClone(state));
      }
      if (!['accepted', 'failed'].includes(request.status)) {
        return fail(state, 'invalid-transition');
      }
      const next = structuredClone(state);
      next.queue[index] = { ...request, status: 'queued' };
      if (!next.recordingQueue.includes(event.requestId)) {
        next.recordingQueue.push(event.requestId);
      }
      return ok(next);
    }
    case 'recording-reordered': {
      const from = state.recordingQueue.indexOf(event.requestId);
      if (
        from < 0 ||
        !Number.isInteger(event.toIndex) ||
        event.toIndex < 0 ||
        event.toIndex >= state.recordingQueue.length
      ) {
        return fail(state, 'invalid-transition');
      }
      const next = structuredClone(state);
      const [requestId] = next.recordingQueue.splice(from, 1);
      if (!requestId) return fail(state, 'invalid-transition');
      next.recordingQueue.splice(event.toIndex, 0, requestId);
      return ok(next);
    }
    case 'recording-removed': {
      const queueIndex = state.recordingQueue.indexOf(event.requestId);
      const index = requestIndex(event.requestId);
      const request = state.queue[index];
      if (queueIndex < 0 || !request || request.status !== 'queued') {
        return fail(state, 'invalid-transition');
      }
      const next = structuredClone(state);
      next.recordingQueue.splice(queueIndex, 1);
      next.queue[index] = { ...request, status: 'accepted' };
      return ok(next);
    }
    case 'recording-started': {
      const coordinatorId = clean(event.coordinatorId, 120, true);
      if (!coordinatorId) return fail(state, 'invalid-transition');
      if (state.currentRecording?.requestId === event.requestId) {
        const next = structuredClone(state);
        const recording = next.currentRecording;
        if (!recording) return fail(state, 'invalid-transition');
        if (!recording.coordinatorId) {
          recording.coordinatorId = coordinatorId;
        }
        return ok(next);
      }
      if (state.currentRecording) return fail(state, 'recording-active');
      const index = requestIndex(event.requestId);
      const request = state.queue[index];
      if (
        !request ||
        request.status !== 'queued' ||
        state.recordingQueue[0] !== event.requestId
      ) {
        return fail(state, 'invalid-transition');
      }
      const next = structuredClone(state);
      next.recordingQueue.shift();
      next.queue[index] = { ...request, status: 'recording' };
      next.currentRecording = {
        requestId: event.requestId,
        coordinatorId,
        startedAt: event.at,
        lyrics: null,
      };
      return ok(next);
    }
    case 'lyrics-ready': {
      if (state.currentRecording?.requestId !== event.requestId) {
        return fail(state, 'invalid-transition');
      }
      const lyrics = cleanLyrics(event.lyrics);
      if (!lyrics) return fail(state, 'invalid-lyrics');
      const next = structuredClone(state);
      if (!next.currentRecording) return fail(state, 'invalid-transition');
      next.currentRecording.lyrics = lyrics;
      return ok(next);
    }
    case 'recording-failed': {
      if (state.currentRecording?.requestId !== event.requestId) {
        return fail(state, 'invalid-transition');
      }
      const index = requestIndex(event.requestId);
      const request = state.queue[index];
      if (!request) return fail(state, 'invalid-transition');
      const next = structuredClone(state);
      next.queue[index] = { ...request, status: 'failed' };
      next.currentRecording = null;
      return ok(next);
    }
    case 'song-shared': {
      const validShareId = /^[A-Za-z0-9_-]{16}$/.test(event.shareId);
      const lyrics = cleanLyrics(event.lyrics);
      const lyricTiming = normalizeLyricTiming(event.lyricTiming);
      const invalidTiming = event.lyricTiming != null && !lyricTiming;
      if (!validShareId || !lyrics || state.currentRecording || invalidTiming) {
        return fail(state, 'invalid-song');
      }
      const next = structuredClone(state);
      const readySong: SetlistSong = {
        requestId: null,
        shareId: event.shareId,
        title: lyrics.title,
        language: lyrics.language,
        startedAt: event.startedAt,
        lyrics,
      };
      if (event.lyricTiming !== undefined) readySong.lyricTiming = lyricTiming;
      next.setlist = next.setlist.filter(
        (song) => song.shareId !== event.shareId,
      );
      next.setlist.push(readySong);
      next.setlist = next.setlist.slice(-ROOM_LIMITS.setlist);
      next.currentSong = {
        ...readySong,
        lyrics,
        playback: {
          status: 'paused',
          positionMs: 0,
          changedAt: event.startedAt,
        },
      };
      return ok(next);
    }
    case 'song-ready': {
      const recording = state.currentRecording;
      const validShareId = /^[A-Za-z0-9_-]{16}$/.test(event.shareId);
      const lyricTiming = normalizeLyricTiming(event.lyricTiming);
      const invalidTiming = event.lyricTiming != null && !lyricTiming;
      const existing = state.setlist.find(
        (song) => song.requestId === event.requestId,
      );
      const existingRequest = state.queue[requestIndex(event.requestId)];
      if (!recording && existing && existingRequest?.status === 'ready') {
        return ok(structuredClone(state));
      }
      if (
        recording?.requestId !== event.requestId ||
        !validShareId ||
        invalidTiming
      ) {
        return fail(state, 'invalid-transition');
      }
      const lyrics = recording.lyrics ?? cleanLyrics(event.lyrics);
      if (!lyrics) return fail(state, 'invalid-lyrics');
      const index = requestIndex(event.requestId);
      const request = state.queue[index];
      if (!request) return fail(state, 'invalid-transition');
      const next = structuredClone(state);
      const readySong: SetlistSong = {
        requestId: event.requestId,
        shareId: event.shareId,
        title: lyrics.title,
        language: lyrics.language,
        startedAt: event.startedAt,
        lyrics,
      };
      if (event.lyricTiming !== undefined) readySong.lyricTiming = lyricTiming;
      next.setlist = next.setlist.filter(
        (song) => song.requestId !== event.requestId,
      );
      next.setlist.push(readySong);
      next.setlist = next.setlist.slice(-ROOM_LIMITS.setlist);
      if (!next.currentSong) {
        next.currentSong = {
          ...readySong,
          lyrics,
          playback: {
            status: 'paused',
            positionMs: 0,
            changedAt: event.startedAt,
          },
        };
      }
      next.queue[index] = { ...request, status: 'ready' };
      next.currentRecording = null;
      return ok(next);
    }
    case 'song-selected': {
      if (state.currentSong?.shareId === event.shareId)
        return ok(structuredClone(state));
      const song = state.setlist.find(
        (candidate) => candidate.shareId === event.shareId,
      );
      if (!song?.lyrics) return fail(state, 'invalid-song');
      const next = structuredClone(state);
      next.currentSong = {
        ...song,
        lyrics: song.lyrics,
        playback: {
          status: 'paused',
          positionMs: 0,
          changedAt: event.at,
        },
      };
      return ok(next);
    }
    case 'playback-updated': {
      const validSong = state.currentSong?.shareId === event.shareId;
      const validPosition =
        Number.isFinite(event.positionMs) &&
        event.positionMs >= 0 &&
        event.positionMs <= 24 * 60 * 60 * 1000;
      if (!validSong || !validPosition || !state.currentSong) {
        return fail(state, 'invalid-playback');
      }
      const next = structuredClone(state);
      if (!next.currentSong) return fail(state, 'invalid-playback');
      next.currentSong.playback = {
        status: event.status,
        positionMs: Math.round(event.positionMs),
        changedAt: event.at,
      };
      return ok(next);
    }
    case 'kicked': {
      const index = participantIndex(event.participantId);
      if (index < 0) return fail(state, 'not-found');
      const next = structuredClone(state);
      next.participants.splice(index, 1);
      if (!next.kickedParticipantIds.includes(event.participantId)) {
        next.kickedParticipantIds.push(event.participantId);
      }
      return ok(next, [
        { type: 'close-participant', participantId: event.participantId },
      ]);
    }
    case 'room-expired': {
      const next = structuredClone(state);
      next.expiredAt = event.at;
      next.hostPresent = false;
      next.participants = next.participants.map((item) => ({
        ...item,
        connected: false,
      }));
      return ok(next, [{ type: 'close-all' }]);
    }
  }
}

export type RoomProjection = ReturnType<typeof projectRoomState>;

export function projectRoomState(
  state: RoomState,
  viewer: { role?: RoomEvent['role']; participantId?: string } = {},
) {
  const connected = state.participants.filter((item) => item.connected);
  return {
    version: state.version,
    roomId: state.roomId,
    openedAt: state.openedAt,
    expiresAt: state.expiresAt,
    expiredAt: state.expiredAt,
    hostPresent: state.hostPresent,
    participants: connected.map((item) =>
      viewer.role === 'host' ? item : { name: item.name },
    ),
    listenerCount: connected.length,
    currentRecording: state.currentRecording
      ? viewer.role === 'host'
        ? state.currentRecording
        : {
            requestId: state.currentRecording.requestId,
            startedAt: state.currentRecording.startedAt,
          }
      : null,
    currentSong: state.currentSong,
    setlist:
      viewer.role === 'host'
        ? state.setlist
        : state.setlist.map((song) => ({
            shareId: song.shareId,
            title: song.title,
            language: song.language,
            startedAt: song.startedAt,
          })),
    recordingQueue: [...state.recordingQueue],
    queue:
      viewer.role === 'host'
        ? state.queue
        : state.queue.map((item) => ({
            id: item.id,
            status: item.status,
            mine: item.participantId === viewer.participantId,
          })),
  };
}
