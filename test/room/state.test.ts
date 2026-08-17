import { describe, expect, test } from 'vitest';

import type { LyricTiming } from '../../src/lyrics/lyric-sync.ts';
import type {
  RoomErrorCode,
  RoomEvent,
  RoomState,
  TransitionResult,
} from '../../src/room/protocol.ts';
import {
  createRoomState,
  projectRoomState,
  ROOM_LIMITS,
  transitionRoom,
} from '../../src/room/state.ts';

type EventInput = RoomEvent extends infer Event
  ? Event extends RoomEvent
    ? Omit<Event, 'role' | 'at' | 'actorId'>
    : never
  : never;

const base = () =>
  createRoomState({ roomId: 'ABCDEFGH', openedAt: 1000, expiresAt: 22000 });
const host = (event: EventInput): RoomEvent => ({
  ...event,
  role: 'host',
  at: 2000,
});
const listener = (event: EventInput): RoomEvent => ({
  ...event,
  role: 'listener',
  actorId: 'p1',
  at: 2000,
});
const errorCode = (result: TransitionResult): RoomErrorCode => {
  if (!result.error) throw new Error('Expected the transition to fail');
  return result.error.code;
};
const joined = () =>
  transitionRoom(
    base(),
    listener({ type: 'joined', participantId: 'p1', name: '  Ada  ' }),
  ).state;
const submitted = () =>
  transitionRoom(
    joined(),
    listener({
      type: 'request-submitted',
      participantId: 'p1',
      requestId: 'q1',
      idea: 'rain',
      vibe: 'soft',
      language: 'Hindi',
    }),
  ).state;
const accepted = () =>
  transitionRoom(
    submitted(),
    host({ type: 'request-accepted', requestId: 'q1' }),
  ).state;
const enqueued = () =>
  transitionRoom(
    accepted(),
    host({ type: 'recording-enqueued', requestId: 'q1' }),
  ).state;
const TIMING = {
  version: 1,
  mode: 'minimax-section-asr',
  durationSeconds: 20,
  segments: [
    { start: 0, end: 10, label: 'verse' },
    { start: 10, end: 20, label: 'chorus' },
  ],
} satisfies LyricTiming;

describe('room state', () => {
  test('room creation is versioned', () => {
    expect(base()).toEqual({
      version: 1,
      roomId: 'ABCDEFGH',
      openedAt: 1000,
      expiresAt: 22000,
      expiredAt: null,
      hostPresent: false,
      participants: [],
      kickedParticipantIds: [],
      queue: [],
      recordingQueue: [],
      currentRecording: null,
      currentSong: null,
      setlist: [],
    });
  });

  test('join leave and rejoin normalize names', () => {
    let state = joined();
    expect(state.participants[0]?.name).toBe('Ada');
    state = transitionRoom(
      state,
      listener({ type: 'left', participantId: 'p1' }),
    ).state;
    expect(state.participants[0]?.connected).toBe(false);
    state = transitionRoom(
      state,
      listener({ type: 'joined', participantId: 'p1' }),
    ).state;
    expect(state.participants[0]?.connected).toBe(true);
  });

  test('listener cap is enforced', () => {
    let state = base();
    for (let index = 0; index < ROOM_LIMITS.listeners; index += 1) {
      state = transitionRoom(
        state,
        listener({ type: 'joined', participantId: `p${index}` }),
      ).state;
    }
    expect(
      errorCode(
        transitionRoom(
          state,
          listener({ type: 'joined', participantId: 'overflow' }),
        ),
      ),
    ).toBe('room-full');
  });

  test('payload limits are enforced', () => {
    expect(
      errorCode(
        transitionRoom(
          base(),
          listener({
            type: 'joined',
            participantId: 'p1',
            name: 'x'.repeat(41),
          }),
        ),
      ),
    ).toBe('invalid-name');
    expect(
      errorCode(
        transitionRoom(
          joined(),
          listener({
            type: 'request-submitted',
            participantId: 'p1',
            requestId: 'q',
            idea: 'x'.repeat(201),
          }),
        ),
      ),
    ).toBe('invalid-request');
  });

  test('submissions are FIFO and capped', () => {
    let state = joined();
    for (let index = 0; index < ROOM_LIMITS.queue; index += 1) {
      state = transitionRoom(
        state,
        listener({
          type: 'request-submitted',
          participantId: 'p1',
          requestId: `q${index}`,
          idea: `song ${index}`,
        }),
      ).state;
    }
    expect(state.queue[0]?.id).toBe('q0');
    expect(
      errorCode(
        transitionRoom(
          state,
          listener({
            type: 'request-submitted',
            participantId: 'p1',
            requestId: 'qx',
            idea: 'x',
          }),
        ),
      ),
    ).toBe('queue-full');
  });

  test('host manages queue and listener cannot', () => {
    const state = submitted();
    expect(
      errorCode(
        transitionRoom(
          state,
          listener({ type: 'request-accepted', requestId: 'q1' }),
        ),
      ),
    ).toBe('host-only');
    expect(
      transitionRoom(state, host({ type: 'request-accepted', requestId: 'q1' }))
        .state.queue[0]?.status,
    ).toBe('accepted');
  });

  test('reorder and decline require valid transitions', () => {
    let state = submitted();
    state = transitionRoom(
      state,
      listener({
        type: 'request-submitted',
        participantId: 'p1',
        requestId: 'q2',
        idea: 'sun',
      }),
    ).state;
    state = transitionRoom(
      state,
      host({ type: 'request-reordered', requestId: 'q2', toIndex: 0 }),
    ).state;
    expect(state.queue[0]?.id).toBe('q2');
    state = transitionRoom(
      state,
      host({ type: 'request-declined', requestId: 'q2' }),
    ).state;
    expect(state.queue[0]?.status).toBe('declined');
  });

  test('record actions queue idempotently and only the queue head starts', () => {
    let state = transitionRoom(
      enqueued(),
      host({
        type: 'recording-started',
        requestId: 'q1',
        coordinatorId: 'tab-a',
      }),
    ).state;
    expect(
      transitionRoom(
        state,
        host({
          type: 'recording-started',
          requestId: 'q1',
          coordinatorId: 'tab-b',
        }),
      ).error,
    ).toBeUndefined();
    expect(state.currentRecording?.coordinatorId).toBe('tab-a');
    state = transitionRoom(
      state,
      host({ type: 'recording-failed', requestId: 'q1' }),
    ).state;
    expect(state.queue[0]?.status).toBe('failed');
    state = transitionRoom(
      state,
      host({ type: 'recording-enqueued', requestId: 'q1' }),
    ).state;
    const repeated = transitionRoom(
      state,
      host({ type: 'recording-enqueued', requestId: 'q1' }),
    ).state;
    expect(repeated.recordingQueue).toEqual(['q1']);
  });

  test('queued recordings can be reordered and removed only before they start', () => {
    let state = accepted();
    state = transitionRoom(
      state,
      listener({
        type: 'request-submitted',
        participantId: 'p1',
        requestId: 'q2',
        idea: 'sun',
      }),
    ).state;
    state = transitionRoom(
      state,
      host({ type: 'request-accepted', requestId: 'q2' }),
    ).state;
    for (const requestId of ['q1', 'q2']) {
      state = transitionRoom(
        state,
        host({ type: 'recording-enqueued', requestId }),
      ).state;
    }
    state = transitionRoom(
      state,
      host({ type: 'recording-reordered', requestId: 'q2', toIndex: 0 }),
    ).state;
    expect(state.recordingQueue).toEqual(['q2', 'q1']);
    expect(
      errorCode(
        transitionRoom(
          state,
          host({
            type: 'recording-started',
            requestId: 'q1',
            coordinatorId: 'tab-a',
          }),
        ),
      ),
    ).toBe('invalid-transition');
    state = transitionRoom(
      state,
      host({ type: 'recording-removed', requestId: 'q2' }),
    ).state;
    expect(state.recordingQueue).toEqual(['q1']);
    expect(state.queue.find((item) => item.id === 'q2')?.status).toBe(
      'accepted',
    );
  });

  test('lyrics and ready populate a paused current song', () => {
    let state = transitionRoom(
      enqueued(),
      host({
        type: 'recording-started',
        requestId: 'q1',
        coordinatorId: 'tab-a',
      }),
    ).state;
    state = transitionRoom(
      state,
      host({
        type: 'lyrics-ready',
        requestId: 'q1',
        lyrics: {
          title: 'Rain',
          language: 'Hindi',
          lyricsNative: 'बारिश',
          lyricsRoman: 'baarish',
          prompt: 'secret',
        },
      }),
    ).state;
    state = transitionRoom(
      state,
      host({
        type: 'song-ready',
        requestId: 'q1',
        shareId: 'abcdefghijklmnop',
        startedAt: 5000,
        lyricTiming: TIMING,
      }),
    ).state;
    expect(state.currentSong?.lyrics).not.toHaveProperty('prompt');
    expect(state.currentSong?.lyricTiming).toEqual(TIMING);
    expect(state.setlist[0]?.lyricTiming).toEqual(TIMING);
    expect(
      projectRoomState(state, { role: 'listener' }).currentSong?.playback,
    ).toEqual({ status: 'paused', positionMs: 0, changedAt: 5000 });
  });

  test('host can share a standalone song into the live room', () => {
    const event = {
      type: 'song-shared' as const,
      shareId: 'abcdefghijklmnop',
      startedAt: 5000,
      lyrics: {
        title: 'Body on Fire',
        language: 'English',
        nativeScriptName: 'Latin',
        isLatinScript: true,
        lyricsNative: 'Sun came in',
        lyricsRoman: 'Sun came in',
        prompt: 'must not leak',
      },
      lyricTiming: null,
    };
    expect(errorCode(transitionRoom(base(), listener(event)))).toBe(
      'host-only',
    );
    const state = transitionRoom(base(), host(event)).state;
    expect(state.currentSong?.title).toBe('Body on Fire');
    expect(state.currentSong?.lyrics).not.toHaveProperty('prompt');
    expect(state.currentSong?.lyricTiming).toBeNull();
    expect(state.currentSong?.playback).toEqual({
      status: 'paused',
      positionMs: 0,
      changedAt: 5000,
    });
  });

  test('rejects invalid room timing while preserving legacy absence', () => {
    const event = {
      type: 'song-shared' as const,
      shareId: 'abcdefghijklmnop',
      startedAt: 5000,
      lyrics: {
        title: 'Body on Fire',
        language: 'English',
        nativeScriptName: 'Latin',
        isLatinScript: true,
        lyricsNative: 'Sun came in',
        lyricsRoman: 'Sun came in',
      },
    };
    const legacy = transitionRoom(base(), host(event)).state;
    expect(legacy.currentSong).not.toHaveProperty('lyricTiming');
    expect(
      errorCode(
        transitionRoom(
          base(),
          host({
            ...event,
            lyricTiming: { ...TIMING, durationSeconds: -1 },
          }),
        ),
      ),
    ).toBe('invalid-song');
  });

  test('only the host controls current-song playback', () => {
    let state = transitionRoom(
      enqueued(),
      host({
        type: 'recording-started',
        requestId: 'q1',
        coordinatorId: 'tab-a',
      }),
    ).state;
    state = transitionRoom(
      state,
      host({
        type: 'lyrics-ready',
        requestId: 'q1',
        lyrics: {
          title: 'Rain',
          language: 'Hindi',
          lyricsNative: 'बारिश',
          lyricsRoman: 'baarish',
        },
      }),
    ).state;
    state = transitionRoom(
      state,
      host({
        type: 'song-ready',
        requestId: 'q1',
        shareId: 'abcdefghijklmnop',
        startedAt: 5000,
      }),
    ).state;
    const command = {
      type: 'playback-updated' as const,
      shareId: 'abcdefghijklmnop',
      status: 'playing' as const,
      positionMs: 1200,
    };
    expect(errorCode(transitionRoom(state, listener(command)))).toBe(
      'host-only',
    );
    state = transitionRoom(state, host(command)).state;
    expect(state.currentSong?.playback).toEqual({
      status: 'playing',
      positionMs: 1200,
      changedAt: 2000,
    });
    expect(
      errorCode(transitionRoom(state, host({ ...command, shareId: 'wrong' }))),
    ).toBe('invalid-playback');
    expect(
      errorCode(transitionRoom(state, host({ ...command, positionMs: -1 }))),
    ).toBe('invalid-playback');
  });

  test('a background recording becomes ready without changing current playback', () => {
    const state: RoomState = base();
    state.currentSong = {
      requestId: null,
      shareId: 'aaaaaaaaaaaaaaaa',
      title: 'A',
      language: 'x',
      startedAt: 1,
      lyrics: {
        title: 'A',
        language: 'x',
        nativeScriptName: '',
        isLatinScript: true,
        lyricsNative: 'a',
        lyricsRoman: 'a',
      },
      playback: { status: 'paused', positionMs: 0, changedAt: 1 },
    };
    state.participants = [
      { id: 'p1', name: 'A', connected: true, joinedAt: 1 },
    ];
    state.queue = [
      {
        id: 'q1',
        participantId: 'p1',
        idea: 'B',
        vibe: '',
        language: 'y',
        status: 'recording',
        submittedAt: 1,
      },
    ];
    state.currentRecording = {
      requestId: 'q1',
      coordinatorId: 'tab-a',
      startedAt: 1,
      lyrics: {
        title: 'B',
        language: 'y',
        nativeScriptName: '',
        isLatinScript: true,
        lyricsNative: 'b',
        lyricsRoman: 'b',
      },
    };
    const next = transitionRoom(
      state,
      host({
        type: 'song-ready',
        requestId: 'q1',
        shareId: 'bbbbbbbbbbbbbbbb',
        startedAt: 2,
      }),
    ).state;
    expect(next.currentSong).toEqual(state.currentSong);
    expect(next.setlist[0]).toMatchObject({
      requestId: 'q1',
      shareId: 'bbbbbbbbbbbbbbbb',
      title: 'B',
    });
    expect(next.queue[0]?.status).toBe('ready');

    const selected = transitionRoom(
      next,
      host({ type: 'song-selected', shareId: 'bbbbbbbbbbbbbbbb' }),
    ).state;
    expect(selected.currentSong).toMatchObject({
      requestId: 'q1',
      shareId: 'bbbbbbbbbbbbbbbb',
      title: 'B',
      language: 'y',
      playback: { status: 'paused', positionMs: 0, changedAt: 2000 },
    });
  });

  test('projections hide participant ids from listeners', () => {
    const state = submitted();
    expect(
      projectRoomState(state, { role: 'host' }).participants[0],
    ).toHaveProperty('id', 'p1');
    expect(
      projectRoomState(state, { role: 'listener', participantId: 'p1' })
        .participants[0],
    ).not.toHaveProperty('id');
  });

  test('listener projections expose recording status without lyrics or ready lyrics', () => {
    let state = transitionRoom(
      enqueued(),
      host({
        type: 'recording-started',
        requestId: 'q1',
        coordinatorId: 'tab-a',
      }),
    ).state;
    state = transitionRoom(
      state,
      host({
        type: 'lyrics-ready',
        requestId: 'q1',
        lyrics: {
          title: 'Rain',
          language: 'Hindi',
          lyricsNative: 'बारिश',
          lyricsRoman: 'baarish',
        },
      }),
    ).state;
    const projected = projectRoomState(state, {
      role: 'listener',
      participantId: 'p1',
    });
    expect(projected.currentRecording).toEqual({
      requestId: 'q1',
      startedAt: 2000,
    });
    expect(projected.currentRecording).not.toHaveProperty('lyrics');
  });

  test('input state is immutable', () => {
    const state = submitted();
    const before = structuredClone(state);
    transitionRoom(state, host({ type: 'request-accepted', requestId: 'q1' }));
    expect(state).toEqual(before);
  });

  test('kick blocks identity rejoin', () => {
    const state = transitionRoom(
      joined(),
      host({ type: 'kicked', participantId: 'p1' }),
    ).state;
    expect(
      errorCode(
        transitionRoom(
          state,
          listener({ type: 'joined', participantId: 'p1' }),
        ),
      ),
    ).toBe('kicked');
  });

  test('expiry is terminal', () => {
    const state = transitionRoom(base(), host({ type: 'room-expired' })).state;
    expect(
      errorCode(
        transitionRoom(
          state,
          listener({ type: 'joined', participantId: 'p1' }),
        ),
      ),
    ).toBe('room-expired');
  });

  test('lyrics-ready enforces share metadata ceilings', () => {
    const state = transitionRoom(
      enqueued(),
      host({
        type: 'recording-started',
        requestId: 'q1',
        coordinatorId: 'tab-a',
      }),
    ).state;
    const valid = {
      title: 'T',
      language: 'Hindi',
      nativeScriptName: 'Devanagari',
      lyricsNative: 'गीत',
      lyricsRoman: 'geet',
    };
    for (const lyrics of [
      { ...valid, title: 'x'.repeat(121) },
      { ...valid, language: 'x'.repeat(81) },
      { ...valid, nativeScriptName: 'x'.repeat(81) },
      { ...valid, lyricsNative: 'x'.repeat(5001) },
      { ...valid, lyricsRoman: 'x'.repeat(5001) },
    ]) {
      expect(
        errorCode(
          transitionRoom(
            state,
            host({ type: 'lyrics-ready', requestId: 'q1', lyrics }),
          ),
        ),
      ).toBe('invalid-lyrics');
    }
    const next = transitionRoom(
      state,
      host({ type: 'lyrics-ready', requestId: 'q1', lyrics: valid }),
    ).state;
    expect(next.currentRecording?.lyrics?.title).toBe('T');
  });
});
