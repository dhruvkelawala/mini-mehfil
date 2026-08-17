import type {
  LyricsSheet,
  RoomEffect,
  RoomErrorCode,
  RoomEvent,
  RoomState,
  TransitionResult,
} from './protocol.ts';
import { isRecord } from './protocol.ts';

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
  'recording-started',
  'lyrics-ready',
  'recording-failed',
  'song-ready',
  'song-shared',
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
  value: unknown,
  max: number,
  required = false,
): string | null => {
  const text =
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return (!required || text) && text.length <= max ? text : null;
};

function cleanLyrics(sheet: unknown): LyricsSheet | null {
  if (!isRecord(sheet)) return null;
  const title = clean(sheet.title, 120, true);
  const language = clean(sheet.language, 80, true);
  const nativeScriptName = clean(sheet.nativeScriptName, 80);
  const lyricsNative =
    typeof sheet.lyricsNative === 'string' &&
    sheet.lyricsNative.trim() &&
    sheet.lyricsNative.length <= 5000
      ? sheet.lyricsNative
      : null;
  const lyricsRoman =
    typeof sheet.lyricsRoman === 'string' &&
    sheet.lyricsRoman.trim() &&
    sheet.lyricsRoman.length <= 5000
      ? sheet.lyricsRoman
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
  const next = structuredClone(state);
  const participantIndex = (id: string) =>
    next.participants.findIndex((item) => item.id === id);
  const requestIndex = (id: string) =>
    next.queue.findIndex((item) => item.id === id);

  switch (event.type) {
    case 'room-opened':
      return ok(next);
    case 'joined': {
      if (next.kickedParticipantIds.includes(event.participantId)) {
        return fail(state, 'kicked');
      }
      const existing = participantIndex(event.participantId);
      const name = clean(event.name, ROOM_LIMITS.name);
      if (name === null) return fail(state, 'invalid-name');
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
        const listenerCount = next.participants.filter(
          (item) => item.connected,
        ).length;
        if (listenerCount >= ROOM_LIMITS.listeners) {
          return fail(state, 'room-full');
        }
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
      if (event.role === 'host') next.hostPresent = false;
      else {
        const index = participantIndex(event.participantId);
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
      const activeRequestCount = next.queue.filter(
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
      const request = next.queue[index];
      if (!request || request.status !== 'pending') {
        return fail(state, 'invalid-transition');
      }
      next.queue[index] = { ...request, status: 'accepted' };
      return ok(next);
    }
    case 'request-reordered': {
      const from = requestIndex(event.requestId);
      const request = next.queue[from];
      const invalidTarget =
        !Number.isInteger(event.toIndex) ||
        event.toIndex < 0 ||
        event.toIndex >= next.queue.length;
      const movable =
        request !== undefined &&
        ['pending', 'accepted'].includes(request.status);
      if (invalidTarget || !movable) return fail(state, 'invalid-transition');
      const [item] = next.queue.splice(from, 1);
      if (!item) return fail(state, 'invalid-transition');
      next.queue.splice(event.toIndex, 0, item);
      return ok(next);
    }
    case 'request-declined': {
      const index = requestIndex(event.requestId);
      const request = next.queue[index];
      if (!request || !['pending', 'accepted'].includes(request.status)) {
        return fail(state, 'invalid-transition');
      }
      next.queue[index] = { ...request, status: 'declined' };
      return ok(next);
    }
    case 'recording-started': {
      if (next.currentRecording) return fail(state, 'recording-active');
      const index = requestIndex(event.requestId);
      const request = next.queue[index];
      if (!request || request.status !== 'accepted') {
        return fail(state, 'invalid-transition');
      }
      next.queue[index] = { ...request, status: 'recording' };
      next.currentRecording = {
        requestId: event.requestId,
        startedAt: event.at,
        lyrics: null,
      };
      return ok(next);
    }
    case 'lyrics-ready': {
      if (next.currentRecording?.requestId !== event.requestId) {
        return fail(state, 'invalid-transition');
      }
      const lyrics = cleanLyrics(event.lyrics);
      if (!lyrics) return fail(state, 'invalid-lyrics');
      next.currentRecording.lyrics = lyrics;
      return ok(next);
    }
    case 'recording-failed': {
      if (next.currentRecording?.requestId !== event.requestId) {
        return fail(state, 'invalid-transition');
      }
      const index = requestIndex(event.requestId);
      const request = next.queue[index];
      if (!request) return fail(state, 'invalid-transition');
      next.queue[index] = { ...request, status: 'accepted' };
      next.currentRecording = null;
      return ok(next);
    }
    case 'song-shared': {
      const validShareId = /^[A-Za-z0-9_-]{16}$/.test(event.shareId);
      const lyrics = cleanLyrics(event.lyrics);
      if (!validShareId || !lyrics || next.currentRecording) {
        return fail(state, 'invalid-song');
      }
      if (next.currentSong) {
        next.setlist.push({
          shareId: next.currentSong.shareId,
          title: next.currentSong.title,
          language: next.currentSong.language,
          startedAt: next.currentSong.startedAt,
        });
      }
      next.setlist = next.setlist.slice(-ROOM_LIMITS.setlist);
      next.currentSong = {
        shareId: event.shareId,
        title: lyrics.title,
        language: lyrics.language,
        startedAt: event.startedAt,
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
      const recording = next.currentRecording;
      const validShareId = /^[A-Za-z0-9_-]{16}$/.test(event.shareId);
      if (recording?.requestId !== event.requestId || !validShareId) {
        return fail(state, 'invalid-transition');
      }
      const lyrics = recording.lyrics ?? cleanLyrics(event.lyrics);
      if (!lyrics) return fail(state, 'invalid-lyrics');
      if (next.currentSong) {
        next.setlist.push({
          shareId: next.currentSong.shareId,
          title: next.currentSong.title,
          language: next.currentSong.language,
          startedAt: next.currentSong.startedAt,
        });
      }
      next.setlist = next.setlist.slice(-ROOM_LIMITS.setlist);
      next.currentSong = {
        shareId: event.shareId,
        title: lyrics.title,
        language: lyrics.language,
        startedAt: event.startedAt,
        lyrics,
        playback: {
          status: 'paused',
          positionMs: 0,
          changedAt: event.startedAt,
        },
      };
      const index = requestIndex(event.requestId);
      const request = next.queue[index];
      if (!request) return fail(state, 'invalid-transition');
      next.queue[index] = { ...request, status: 'ready' };
      next.currentRecording = null;
      return ok(next);
    }
    case 'playback-updated': {
      const validSong = next.currentSong?.shareId === event.shareId;
      const validPosition =
        Number.isFinite(event.positionMs) &&
        event.positionMs >= 0 &&
        event.positionMs <= 24 * 60 * 60 * 1000;
      if (!validSong || !validPosition || !next.currentSong) {
        return fail(state, 'invalid-playback');
      }
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
      next.participants.splice(index, 1);
      if (!next.kickedParticipantIds.includes(event.participantId)) {
        next.kickedParticipantIds.push(event.participantId);
      }
      return ok(next, [
        { type: 'close-participant', participantId: event.participantId },
      ]);
    }
    case 'room-expired':
      next.expiredAt = event.at;
      next.hostPresent = false;
      next.participants = next.participants.map((item) => ({
        ...item,
        connected: false,
      }));
      return ok(next, [{ type: 'close-all' }]);
  }
}

export type RoomProjection = ReturnType<typeof projectRoomState>;

export function projectRoomState(
  state: RoomState,
  viewer: { role?: RoomEvent['role']; participantId?: string } = {},
) {
  return {
    version: state.version,
    roomId: state.roomId,
    openedAt: state.openedAt,
    expiresAt: state.expiresAt,
    expiredAt: state.expiredAt,
    hostPresent: state.hostPresent,
    participants: state.participants
      .filter((item) => item.connected)
      .map((item) =>
        viewer.role === 'host' ? { ...item } : { name: item.name },
      ),
    listenerCount: state.participants.filter((item) => item.connected).length,
    currentRecording: state.currentRecording
      ? structuredClone(state.currentRecording)
      : null,
    currentSong: state.currentSong ? structuredClone(state.currentSong) : null,
    setlist: structuredClone(state.setlist),
    queue:
      viewer.role === 'host'
        ? structuredClone(state.queue)
        : state.queue.map((item) => ({
            id: item.id,
            status: item.status,
            mine: item.participantId === viewer.participantId,
          })),
  };
}
