import { expect, test } from 'vitest';

import { parseClientMessage, parseRoomState } from '../../src/room/protocol.ts';
import { createRoomState } from '../../src/room/state.ts';

const TIMING = {
  version: 1,
  mode: 'minimax-section-asr',
  durationSeconds: 20,
  segments: [
    { start: 0, end: 10, label: 'verse' },
    { start: 10, end: 20, label: 'chorus' },
  ],
};

test('client message parsing rejects malformed fields at the wire boundary', () => {
  expect(parseClientMessage(null)).toBeNull();
  expect(
    parseClientMessage({ type: 'request-submitted', idea: 12 }),
  ).toBeNull();
  expect(
    parseClientMessage({
      type: 'playback-updated',
      shareId: 'abcdefghijklmnop',
      status: 'rewinding',
      positionMs: 1,
    }),
  ).toBeNull();
  expect(parseClientMessage({ type: 'join', name: 'Ada' })).toEqual({
    type: 'join',
    name: 'Ada',
  });
  expect(
    parseClientMessage({
      type: 'song-ready',
      requestId: 'q1',
      shareId: 'abcdefghijklmnop',
      lyricTiming: TIMING,
    }),
  ).toEqual({
    type: 'song-ready',
    requestId: 'q1',
    shareId: 'abcdefghijklmnop',
    lyricTiming: TIMING,
  });
  expect(
    parseClientMessage({
      type: 'song-shared',
      shareId: 'abcdefghijklmnop',
      lyrics: {},
      lyricTiming: null,
    }),
  ).toEqual({
    type: 'song-shared',
    shareId: 'abcdefghijklmnop',
    lyrics: {},
    lyricTiming: null,
  });
  expect(
    parseClientMessage({
      type: 'song-ready',
      requestId: 'q1',
      shareId: 'abcdefghijklmnop',
      lyricTiming: { ...TIMING, durationSeconds: -1 },
    }),
  ).toBeNull();
});

test('persisted state parsing rejects corrupt nested records', () => {
  const state = createRoomState({
    roomId: 'ABCDEFGH',
    openedAt: 1000,
    expiresAt: 2000,
  });
  expect(parseRoomState(state)).toEqual(state);
  expect(parseRoomState({ ...state, participants: [{ id: 'p1' }] })).toBeNull();
  expect(
    parseRoomState({
      ...state,
      queue: [
        {
          id: 'q1',
          participantId: 'p1',
          idea: 'rain',
          vibe: '',
          language: '',
          status: 'invented',
          submittedAt: 1,
        },
      ],
    }),
  ).toBeNull();

  const legacySong = {
    requestId: null,
    shareId: 'abcdefghijklmnop',
    title: 'Rain',
    language: 'Hindi',
    startedAt: 1,
    lyrics: {
      title: 'Rain',
      language: 'Hindi',
      nativeScriptName: 'Devanagari',
      isLatinScript: false,
      lyricsNative: '[Verse]\nबारिश\n[Chorus]\nफिर',
      lyricsRoman: '[Verse]\nbaarish\n[Chorus]\nphir',
    },
    playback: { status: 'paused', positionMs: 0, changedAt: 1 },
  };
  expect(
    parseRoomState({
      ...state,
      currentSong: legacySong,
      setlist: [legacySong],
    })?.currentSong,
  ).not.toHaveProperty('lyricTiming');
  expect(
    parseRoomState({
      ...state,
      currentSong: { ...legacySong, lyricTiming: null },
      setlist: [{ ...legacySong, lyricTiming: TIMING }],
    }),
  ).toMatchObject({
    currentSong: { lyricTiming: null },
    setlist: [{ lyricTiming: TIMING }],
  });
  expect(
    parseRoomState({
      ...state,
      currentSong: {
        ...legacySong,
        lyricTiming: { ...TIMING, segments: [] },
      },
      setlist: [],
    }),
  ).toBeNull();
});
