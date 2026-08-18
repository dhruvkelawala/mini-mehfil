import {
  isRecord,
  isString,
  isNumber,
  isBoolean,
  type JsonValue,
} from './primitives.ts';
import {
  normalizeLyricTiming,
  type LyricTiming,
} from '../lyrics/lyric-sync.ts';

export { isRecord } from './primitives.ts';

export type RoomRole = 'host' | 'listener';
export type RequestStatus =
  | 'pending'
  | 'accepted'
  | 'queued'
  | 'recording'
  | 'failed'
  | 'declined'
  | 'ready';
export type PlaybackStatus = 'playing' | 'paused';

export type LyricsSheet = {
  title: string;
  language: string;
  nativeScriptName: string;
  isLatinScript: boolean;
  lyricsNative: string;
  lyricsRoman: string;
};

export function parseLyricsSheet(
  value: JsonValue | undefined,
  fallback: Partial<Pick<LyricsSheet, 'title' | 'language'>> = {},
): LyricsSheet | null {
  if (
    !isRecord(value) ||
    !isString(value.nativeScriptName) ||
    !isBoolean(value.isLatinScript) ||
    !isString(value.lyricsNative) ||
    !isString(value.lyricsRoman)
  ) {
    return null;
  }
  const title = isString(value.title) ? value.title : (fallback.title ?? '');
  const language = isString(value.language)
    ? value.language
    : (fallback.language ?? '');
  if (!title || !language) return null;
  return {
    title,
    language,
    nativeScriptName: value.nativeScriptName,
    isLatinScript: value.isLatinScript,
    lyricsNative: value.lyricsNative,
    lyricsRoman: value.lyricsRoman,
  };
}

export type Participant = {
  id: string;
  name: string;
  connected: boolean;
  joinedAt: number;
};

export type SongRequest = {
  id: string;
  participantId: string;
  idea: string;
  vibe: string;
  language: string;
  status: RequestStatus;
  submittedAt: number;
};

export type RoomPlayback = {
  status: PlaybackStatus;
  positionMs: number;
  changedAt: number;
};

export type RoomSong = {
  requestId: string | null;
  shareId: string;
  title: string;
  language: string;
  startedAt: number;
  lyrics: LyricsSheet;
  lyricTiming?: LyricTiming | null;
  playback: RoomPlayback;
};

export type SetlistSong = {
  requestId: string | null;
  shareId: string;
  title: string;
  language: string;
  startedAt: number;
  lyrics: LyricsSheet | null;
  lyricTiming?: LyricTiming | null;
};

export type CurrentRecording = {
  requestId: string;
  coordinatorId: string;
  startedAt: number;
  lyrics: LyricsSheet | null;
};

export type RoomState = {
  version: 1;
  roomId: string;
  openedAt: number;
  expiresAt: number;
  expiredAt: number | null;
  hostPresent: boolean;
  participants: Participant[];
  kickedParticipantIds: string[];
  queue: SongRequest[];
  recordingQueue: string[];
  currentRecording: CurrentRecording | null;
  currentSong: RoomSong | null;
  setlist: SetlistSong[];
};

export type HostRoomProjection = Omit<RoomState, 'kickedParticipantIds'> & {
  listenerCount: number;
};

type EventBase = {
  role: RoomRole;
  at: number;
  actorId?: string;
  trustedAlarm?: boolean;
};

export type RoomEvent =
  | (EventBase & { type: 'room-opened' })
  | (EventBase & {
      type: 'joined';
      participantId: string;
      name?: string;
    })
  | (EventBase & { type: 'left'; participantId: string })
  | (EventBase & {
      type: 'request-submitted';
      participantId: string;
      requestId: string;
      idea: string;
      vibe?: string;
      language?: string;
    })
  | (EventBase & { type: 'request-accepted'; requestId: string })
  | (EventBase & {
      type: 'request-reordered';
      requestId: string;
      toIndex: number;
    })
  | (EventBase & { type: 'request-declined'; requestId: string })
  | (EventBase & { type: 'recording-enqueued'; requestId: string })
  | (EventBase & {
      type: 'recording-reordered';
      requestId: string;
      toIndex: number;
    })
  | (EventBase & { type: 'recording-removed'; requestId: string })
  | (EventBase & {
      type: 'recording-started';
      requestId: string;
      coordinatorId: string;
    })
  | (EventBase & {
      type: 'lyrics-ready';
      requestId: string;
      lyrics: JsonValue;
    })
  | (EventBase & { type: 'recording-failed'; requestId: string })
  | (EventBase & {
      type: 'song-ready';
      requestId: string;
      shareId: string;
      startedAt: number;
      lyrics?: JsonValue;
      title?: string;
      language?: string;
      lyricTiming?: JsonValue;
    })
  | (EventBase & {
      type: 'song-shared';
      shareId: string;
      lyrics: JsonValue;
      startedAt: number;
      lyricTiming?: JsonValue;
    })
  | (EventBase & { type: 'song-selected'; shareId: string })
  | (EventBase & {
      type: 'playback-updated';
      shareId: string;
      status: PlaybackStatus;
      positionMs: number;
    })
  | (EventBase & { type: 'kicked'; participantId: string })
  | (EventBase & { type: 'room-expired' });

export type RoomEffect =
  { type: 'close-participant'; participantId: string } | { type: 'close-all' };

export type RoomErrorCode =
  | 'invalid-event'
  | 'room-expired'
  | 'host-only'
  | 'kicked'
  | 'invalid-name'
  | 'room-full'
  | 'not-found'
  | 'listener-only'
  | 'queue-full'
  | 'invalid-request'
  | 'invalid-transition'
  | 'recording-active'
  | 'invalid-lyrics'
  | 'invalid-song'
  | 'invalid-playback'
  | 'unknown-event';

export type TransitionResult =
  | { state: RoomState; effects: RoomEffect[]; error?: never }
  | {
      state: RoomState;
      effects: RoomEffect[];
      error: { code: RoomErrorCode };
    };

export type RoomSession = {
  authenticated: boolean;
  connectedAt?: number;
  role?: RoomRole;
  participantId?: string;
};

export type ClientMessage =
  | { type: 'auth-host'; secret: string }
  | { type: 'join'; name?: string; resume?: string }
  | {
      type: 'request-submitted';
      idea: string;
      vibe?: string;
      language?: string;
    }
  | { type: 'request-accepted'; requestId: string }
  | { type: 'request-reordered'; requestId: string; toIndex: number }
  | { type: 'request-declined'; requestId: string }
  | { type: 'recording-enqueued'; requestId: string }
  | { type: 'recording-reordered'; requestId: string; toIndex: number }
  | { type: 'recording-removed'; requestId: string }
  | { type: 'recording-started'; requestId: string; coordinatorId: string }
  | { type: 'lyrics-ready'; requestId: string; lyrics: JsonValue }
  | { type: 'recording-failed'; requestId: string }
  | {
      type: 'song-ready';
      requestId: string;
      shareId: string;
      lyricTiming?: LyricTiming | null;
    }
  | {
      type: 'song-shared';
      shareId: string;
      lyrics: JsonValue;
      lyricTiming?: LyricTiming | null;
    }
  | { type: 'song-selected'; shareId: string }
  | {
      type: 'playback-updated';
      shareId: string;
      status: PlaybackStatus;
      positionMs: number;
    }
  | { type: 'kicked'; participantId: string }
  | { type: 'room-expired' };

const CLIENT_TYPES = new Set<ClientMessage['type']>([
  'auth-host',
  'join',
  'request-submitted',
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

function isRequestStatus(value: string): value is RequestStatus {
  return (
    value === 'pending' ||
    value === 'accepted' ||
    value === 'queued' ||
    value === 'recording' ||
    value === 'failed' ||
    value === 'declined' ||
    value === 'ready'
  );
}

function optionalLyricTiming(
  value: JsonValue | undefined,
): { lyricTiming?: LyricTiming | null } | null {
  if (value === undefined) return {};
  if (value === null) return { lyricTiming: null };
  const timing = normalizeLyricTiming(value);
  return timing ? { lyricTiming: timing } : null;
}

export function parseClientMessage(
  value: JsonValue | undefined,
): ClientMessage | null {
  if (!isRecord(value) || !isString(value.type)) return null;
  // SAFETY: CLIENT_TYPES contains exactly the ClientMessage discriminants; the
  // membership test below rejects any other value before the switch dispatches.
  if (!CLIENT_TYPES.has(value.type as ClientMessage['type'])) return null;
  switch (value.type) {
    case 'auth-host':
      return isString(value.secret)
        ? { type: 'auth-host', secret: value.secret }
        : null;
    case 'join': {
      if (value.name !== undefined && !isString(value.name)) return null;
      if (value.resume !== undefined && !isString(value.resume)) return null;
      const message: ClientMessage = { type: 'join' };
      if (value.name !== undefined) message.name = value.name;
      if (value.resume !== undefined) message.resume = value.resume;
      return message;
    }
    case 'request-submitted': {
      if (!isString(value.idea)) return null;
      if (value.vibe !== undefined && !isString(value.vibe)) return null;
      if (value.language !== undefined && !isString(value.language))
        return null;
      const message: ClientMessage = {
        type: 'request-submitted',
        idea: value.idea,
      };
      if (value.vibe !== undefined) message.vibe = value.vibe;
      if (value.language !== undefined) message.language = value.language;
      return message;
    }
    case 'request-reordered':
    case 'recording-reordered':
      return isString(value.requestId) && isNumber(value.toIndex)
        ? {
            type: value.type,
            requestId: value.requestId,
            toIndex: value.toIndex,
          }
        : null;
    case 'lyrics-ready':
      return isString(value.requestId) && value.lyrics !== undefined
        ? { type: value.type, requestId: value.requestId, lyrics: value.lyrics }
        : null;
    case 'song-ready':
      if (!isString(value.requestId) || !isString(value.shareId)) return null;
      {
        const timing = optionalLyricTiming(value.lyricTiming);
        return timing
          ? {
              type: value.type,
              requestId: value.requestId,
              shareId: value.shareId,
              ...timing,
            }
          : null;
      }
    case 'song-shared': {
      if (!isString(value.shareId) || value.lyrics === undefined) return null;
      const timing = optionalLyricTiming(value.lyricTiming);
      return timing
        ? {
            type: value.type,
            shareId: value.shareId,
            lyrics: value.lyrics,
            ...timing,
          }
        : null;
    }
    case 'song-selected':
      return isString(value.shareId)
        ? { type: value.type, shareId: value.shareId }
        : null;
    case 'playback-updated':
      return isString(value.shareId) &&
        (value.status === 'playing' || value.status === 'paused') &&
        isNumber(value.positionMs)
        ? {
            type: value.type,
            shareId: value.shareId,
            status: value.status,
            positionMs: value.positionMs,
          }
        : null;
    case 'kicked':
      return isString(value.participantId)
        ? { type: value.type, participantId: value.participantId }
        : null;
    case 'request-accepted':
    case 'request-declined':
    case 'recording-enqueued':
    case 'recording-removed':
    case 'recording-failed':
      return isString(value.requestId)
        ? { type: value.type, requestId: value.requestId }
        : null;
    case 'recording-started':
      return isString(value.requestId) && isString(value.coordinatorId)
        ? {
            type: value.type,
            requestId: value.requestId,
            coordinatorId: value.coordinatorId,
          }
        : null;
    case 'room-expired':
      return { type: value.type };
  }
  return null;
}

export function parseRoomState(value: JsonValue | undefined): RoomState | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    !isString(value.roomId) ||
    !isNumber(value.openedAt) ||
    !isNumber(value.expiresAt) ||
    !Array.isArray(value.participants) ||
    !Array.isArray(value.kickedParticipantIds) ||
    !Array.isArray(value.queue) ||
    !Array.isArray(value.setlist) ||
    (value.recordingQueue !== undefined &&
      (!Array.isArray(value.recordingQueue) ||
        !value.recordingQueue.every((item) => isString(item))))
  ) {
    return null;
  }
  const participants: Participant[] = [];
  for (const item of value.participants) {
    if (
      !isRecord(item) ||
      !isString(item.id) ||
      !isString(item.name) ||
      !isBoolean(item.connected) ||
      !isNumber(item.joinedAt)
    ) {
      return null;
    }
    participants.push({
      id: item.id,
      name: item.name,
      connected: item.connected,
      joinedAt: item.joinedAt,
    });
  }
  const queue: SongRequest[] = [];
  for (const item of value.queue) {
    if (
      !isRecord(item) ||
      !isString(item.id) ||
      !isString(item.participantId) ||
      !isString(item.idea) ||
      !isString(item.vibe) ||
      !isString(item.language) ||
      !isString(item.status) ||
      !isRequestStatus(item.status) ||
      !isNumber(item.submittedAt)
    ) {
      return null;
    }
    queue.push({
      id: item.id,
      participantId: item.participantId,
      idea: item.idea,
      vibe: item.vibe,
      language: item.language,
      status: item.status,
      submittedAt: item.submittedAt,
    });
  }
  const parseSetlist = (item: JsonValue | undefined): SetlistSong | null => {
    if (
      !isRecord(item) ||
      !isString(item.shareId) ||
      !isString(item.title) ||
      !isString(item.language) ||
      !isNumber(item.startedAt)
    ) {
      return null;
    }
    const lyrics =
      item.lyrics === undefined ? null : parseLyricsSheet(item.lyrics);
    if (item.lyrics !== undefined && !lyrics) return null;
    if (
      item.requestId !== undefined &&
      item.requestId !== null &&
      !isString(item.requestId)
    )
      return null;
    const timing = optionalLyricTiming(item.lyricTiming);
    if (!timing) return null;
    return {
      requestId: isString(item.requestId) ? item.requestId : null,
      shareId: item.shareId,
      title: item.title,
      language: item.language,
      startedAt: item.startedAt,
      lyrics,
      ...timing,
    };
  };
  const setlist: SetlistSong[] = [];
  for (const item of value.setlist) {
    const parsed = parseSetlist(item);
    if (!parsed) return null;
    setlist.push(parsed);
  }
  let currentRecording: CurrentRecording | null = null;
  if (value.currentRecording !== null) {
    if (
      !isRecord(value.currentRecording) ||
      !isString(value.currentRecording.requestId) ||
      (value.currentRecording.coordinatorId !== undefined &&
        !isString(value.currentRecording.coordinatorId)) ||
      !isNumber(value.currentRecording.startedAt)
    ) {
      return null;
    }
    const lyrics =
      value.currentRecording.lyrics == null
        ? null
        : parseLyricsSheet(value.currentRecording.lyrics);
    if (value.currentRecording.lyrics !== null && !lyrics) return null;
    currentRecording = {
      requestId: value.currentRecording.requestId,
      coordinatorId: isString(value.currentRecording.coordinatorId)
        ? value.currentRecording.coordinatorId
        : '',
      startedAt: value.currentRecording.startedAt,
      lyrics,
    };
  }
  let currentSong: RoomSong | null = null;
  if (value.currentSong !== null) {
    if (!isRecord(value.currentSong)) return null;
    const base = parseSetlist(value.currentSong);
    const lyrics =
      value.currentSong.lyrics === undefined
        ? null
        : parseLyricsSheet(value.currentSong.lyrics);
    const playback = value.currentSong.playback;
    if (
      !base ||
      !lyrics ||
      !isRecord(playback) ||
      (playback.status !== 'playing' && playback.status !== 'paused') ||
      !isNumber(playback.positionMs) ||
      !isNumber(playback.changedAt)
    ) {
      return null;
    }
    currentSong = {
      ...base,
      lyrics,
      playback: {
        status: playback.status,
        positionMs: playback.positionMs,
        changedAt: playback.changedAt,
      },
    };
  }
  if (
    !value.kickedParticipantIds.every((item) => isString(item)) ||
    (value.expiredAt !== null && !isNumber(value.expiredAt)) ||
    !isBoolean(value.hostPresent)
  ) {
    return null;
  }
  return {
    version: 1,
    roomId: value.roomId,
    openedAt: value.openedAt,
    expiresAt: value.expiresAt,
    expiredAt: value.expiredAt,
    hostPresent: value.hostPresent,
    participants,
    kickedParticipantIds: value.kickedParticipantIds,
    queue,
    recordingQueue: Array.isArray(value.recordingQueue)
      ? value.recordingQueue.filter((item): item is string => isString(item))
      : queue.filter((item) => item.status === 'queued').map((item) => item.id),
    currentRecording,
    currentSong,
    setlist,
  };
}

export function parseHostRoomProjection(
  value: JsonValue | undefined,
): HostRoomProjection | null {
  if (!isRecord(value) || !isNumber(value.listenerCount)) return null;
  const parsed = parseRoomState({ ...value, kickedParticipantIds: [] });
  if (!parsed) return null;
  const { kickedParticipantIds, ...projection } = parsed;
  void kickedParticipantIds;
  return { ...projection, listenerCount: value.listenerCount };
}
