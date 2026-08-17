export type RoomRole = 'host' | 'listener';
export type RequestStatus =
  'pending' | 'accepted' | 'recording' | 'declined' | 'ready';
export type PlaybackStatus = 'playing' | 'paused';

export interface LyricsSheet {
  title: string;
  language: string;
  nativeScriptName: string;
  isLatinScript: boolean;
  lyricsNative: string;
  lyricsRoman: string;
}

export interface Participant {
  id: string;
  name: string;
  connected: boolean;
  joinedAt: number;
}

export interface SongRequest {
  id: string;
  participantId: string;
  idea: string;
  vibe: string;
  language: string;
  status: RequestStatus;
  submittedAt: number;
}

export interface RoomPlayback {
  status: PlaybackStatus;
  positionMs: number;
  changedAt: number;
}

export interface RoomSong {
  shareId: string;
  title: string;
  language: string;
  startedAt: number;
  lyrics: LyricsSheet;
  playback: RoomPlayback;
}

export interface SetlistSong {
  shareId: string;
  title: string;
  language: string;
  startedAt: number;
}

export interface CurrentRecording {
  requestId: string;
  startedAt: number;
  lyrics: LyricsSheet | null;
}

export interface RoomState {
  version: 1;
  roomId: string;
  openedAt: number;
  expiresAt: number;
  expiredAt: number | null;
  hostPresent: boolean;
  participants: Participant[];
  kickedParticipantIds: string[];
  queue: SongRequest[];
  currentRecording: CurrentRecording | null;
  currentSong: RoomSong | null;
  setlist: SetlistSong[];
}

interface EventBase {
  role: RoomRole;
  at: number;
  actorId?: string;
  trustedAlarm?: boolean;
}

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
  | (EventBase & { type: 'recording-started'; requestId: string })
  | (EventBase & {
      type: 'lyrics-ready';
      requestId: string;
      lyrics: unknown;
    })
  | (EventBase & { type: 'recording-failed'; requestId: string })
  | (EventBase & {
      type: 'song-ready';
      requestId: string;
      shareId: string;
      startedAt: number;
      lyrics?: unknown;
      title?: string;
      language?: string;
    })
  | (EventBase & {
      type: 'song-shared';
      shareId: string;
      lyrics: unknown;
      startedAt: number;
    })
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

export interface RoomSession {
  authenticated: boolean;
  connectedAt?: number;
  role?: RoomRole;
  participantId?: string;
}

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
  | { type: 'recording-started'; requestId: string }
  | { type: 'lyrics-ready'; requestId: string; lyrics: unknown }
  | { type: 'recording-failed'; requestId: string }
  | { type: 'song-ready'; requestId: string; shareId: string }
  | { type: 'song-shared'; shareId: string; lyrics: unknown }
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
  'recording-started',
  'lyrics-ready',
  'recording-failed',
  'song-ready',
  'song-shared',
  'playback-updated',
  'kicked',
  'room-expired',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestStatus(value: string): value is RequestStatus {
  return (
    value === 'pending' ||
    value === 'accepted' ||
    value === 'recording' ||
    value === 'declined' ||
    value === 'ready'
  );
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (!CLIENT_TYPES.has(value.type as ClientMessage['type'])) return null;
  switch (value.type) {
    case 'auth-host':
      return typeof value.secret === 'string'
        ? { type: 'auth-host', secret: value.secret }
        : null;
    case 'join':
      if (value.name !== undefined && typeof value.name !== 'string')
        return null;
      if (value.resume !== undefined && typeof value.resume !== 'string')
        return null;
      return {
        type: 'join',
        ...(typeof value.name === 'string' ? { name: value.name } : {}),
        ...(typeof value.resume === 'string' ? { resume: value.resume } : {}),
      };
    case 'request-submitted':
      if (typeof value.idea !== 'string') return null;
      if (value.vibe !== undefined && typeof value.vibe !== 'string')
        return null;
      if (value.language !== undefined && typeof value.language !== 'string')
        return null;
      return {
        type: 'request-submitted',
        idea: value.idea,
        ...(typeof value.vibe === 'string' ? { vibe: value.vibe } : {}),
        ...(typeof value.language === 'string'
          ? { language: value.language }
          : {}),
      };
    case 'request-reordered':
      return typeof value.requestId === 'string' &&
        typeof value.toIndex === 'number'
        ? {
            type: value.type,
            requestId: value.requestId,
            toIndex: value.toIndex,
          }
        : null;
    case 'lyrics-ready':
      return typeof value.requestId === 'string'
        ? { type: value.type, requestId: value.requestId, lyrics: value.lyrics }
        : null;
    case 'song-ready':
      return typeof value.requestId === 'string' &&
        typeof value.shareId === 'string'
        ? {
            type: value.type,
            requestId: value.requestId,
            shareId: value.shareId,
          }
        : null;
    case 'song-shared':
      return typeof value.shareId === 'string'
        ? { type: value.type, shareId: value.shareId, lyrics: value.lyrics }
        : null;
    case 'playback-updated':
      return typeof value.shareId === 'string' &&
        (value.status === 'playing' || value.status === 'paused') &&
        typeof value.positionMs === 'number'
        ? {
            type: value.type,
            shareId: value.shareId,
            status: value.status,
            positionMs: value.positionMs,
          }
        : null;
    case 'kicked':
      return typeof value.participantId === 'string'
        ? { type: value.type, participantId: value.participantId }
        : null;
    case 'request-accepted':
    case 'request-declined':
    case 'recording-started':
    case 'recording-failed':
      return typeof value.requestId === 'string'
        ? { type: value.type, requestId: value.requestId }
        : null;
    case 'room-expired':
      return { type: value.type };
  }
  return null;
}

export function parseRoomState(value: unknown): RoomState | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    typeof value.roomId !== 'string' ||
    typeof value.openedAt !== 'number' ||
    typeof value.expiresAt !== 'number' ||
    !Array.isArray(value.participants) ||
    !Array.isArray(value.kickedParticipantIds) ||
    !Array.isArray(value.queue) ||
    !Array.isArray(value.setlist)
  ) {
    return null;
  }
  const participants: Participant[] = [];
  for (const item of value.participants) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.connected !== 'boolean' ||
      typeof item.joinedAt !== 'number'
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
      typeof item.id !== 'string' ||
      typeof item.participantId !== 'string' ||
      typeof item.idea !== 'string' ||
      typeof item.vibe !== 'string' ||
      typeof item.language !== 'string' ||
      typeof item.status !== 'string' ||
      !isRequestStatus(item.status) ||
      typeof item.submittedAt !== 'number'
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
  const parseLyrics = (item: unknown): LyricsSheet | null => {
    if (
      !isRecord(item) ||
      typeof item.title !== 'string' ||
      typeof item.language !== 'string' ||
      typeof item.nativeScriptName !== 'string' ||
      typeof item.isLatinScript !== 'boolean' ||
      typeof item.lyricsNative !== 'string' ||
      typeof item.lyricsRoman !== 'string'
    ) {
      return null;
    }
    return {
      title: item.title,
      language: item.language,
      nativeScriptName: item.nativeScriptName,
      isLatinScript: item.isLatinScript,
      lyricsNative: item.lyricsNative,
      lyricsRoman: item.lyricsRoman,
    };
  };
  const parseSetlist = (item: unknown): SetlistSong | null => {
    if (
      !isRecord(item) ||
      typeof item.shareId !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.language !== 'string' ||
      typeof item.startedAt !== 'number'
    ) {
      return null;
    }
    return {
      shareId: item.shareId,
      title: item.title,
      language: item.language,
      startedAt: item.startedAt,
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
      typeof value.currentRecording.requestId !== 'string' ||
      typeof value.currentRecording.startedAt !== 'number'
    ) {
      return null;
    }
    const lyrics =
      value.currentRecording.lyrics === null
        ? null
        : parseLyrics(value.currentRecording.lyrics);
    if (value.currentRecording.lyrics !== null && !lyrics) return null;
    currentRecording = {
      requestId: value.currentRecording.requestId,
      startedAt: value.currentRecording.startedAt,
      lyrics,
    };
  }
  let currentSong: RoomSong | null = null;
  if (value.currentSong !== null) {
    if (!isRecord(value.currentSong)) return null;
    const base = parseSetlist(value.currentSong);
    const lyrics = parseLyrics(value.currentSong.lyrics);
    const playback = value.currentSong.playback;
    if (
      !base ||
      !lyrics ||
      !isRecord(playback) ||
      (playback.status !== 'playing' && playback.status !== 'paused') ||
      typeof playback.positionMs !== 'number' ||
      typeof playback.changedAt !== 'number'
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
    !value.kickedParticipantIds.every((item) => typeof item === 'string') ||
    (value.expiredAt !== null && typeof value.expiredAt !== 'number') ||
    typeof value.hostPresent !== 'boolean'
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
    currentRecording,
    currentSong,
    setlist,
  };
}
