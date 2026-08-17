import { expect, test } from 'vitest';

import { parseClientMessage, parseRoomState } from '../../src/room/protocol.ts';
import { createRoomState } from '../../src/room/state.ts';

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
});
