import { createRoomState, transitionRoom, projectRoomState } from './room-state.mjs';

export const MAX_MESSAGE_BYTES = 16 * 1024;
export const AUTH_TIMEOUT_MS = 5_000;
export const ABSOLUTE_ROOM_MS = 6 * 60 * 60 * 1000;
export const EMPTY_GRACE_MS = 15 * 60 * 1000;
export const SONG_START_DELAY_MS = 1_500;

export async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(left, right) {
  const a = String(left); const b = String(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
}

export function createRoomTransport({ storage, now = Date.now, randomId, randomCredential, send, broadcast, close, setAttachment, getAttachment, setAlarm, listSockets } = {}) {
  const sockets = new Set();
  const activeSockets = () => listSockets ? listSockets() : [...sockets];
  let state;
  let meta;
  const load = async () => {
    state ||= await storage.get('state');
    meta ||= await storage.get('meta');
    return state;
  };
  const persist = async next => { state = next; await storage.put('state', next); };
  const privateError = (socket, code) => send(socket, { type: 'error', code });
  const snapshot = socket => {
    const viewer = getAttachment(socket) || {};
    send(socket, { type: 'snapshot', state: projectRoomState(state, viewer) });
  };
  const snapshots = async () => broadcast(socket => ({ type: 'snapshot', state: projectRoomState(state, getAttachment(socket) || {}) }));
  const schedule = async () => {
    const connected = [...activeSockets()].some(socket => getAttachment(socket)?.authenticated);
    meta.emptyDeadline = connected ? null : now() + EMPTY_GRACE_MS;
    await storage.put('meta', meta);
    await setAlarm(Math.min(meta.absoluteDeadline, meta.emptyDeadline || Infinity));
  };
  const apply = async (socket, event) => {
    const result = transitionRoom(state, event);
    if (result.error) { privateError(socket, result.error.code); return false; }
    await persist(result.state);
    await snapshots();
    for (const effect of result.effects) {
      if (effect.type === 'close-participant') for (const candidate of activeSockets()) if (getAttachment(candidate)?.participantId === effect.participantId) close(candidate, 4003, 'kicked');
      if (effect.type === 'close-all') for (const candidate of activeSockets()) close(candidate, 4004, 'expired');
    }
    return true;
  };
  return {
    async initialize({ roomId, hostDigest, openedAt = now(), expiresAt = openedAt + ABSOLUTE_ROOM_MS }) {
      if (await storage.get('state')) return false;
      state = createRoomState({ roomId, openedAt, expiresAt });
      meta = { hostDigest, absoluteDeadline: expiresAt, emptyDeadline: null, resumeDigests: {}, kickedDigests: [] };
      await storage.put('state', state); await storage.put('meta', meta); await setAlarm(expiresAt);
      return true;
    },
    async connect(socket) { await load(); sockets.add(socket); setAttachment(socket, { authenticated: false, connectedAt: now() }); },
    async message(socket, raw) {
      await load(); sockets.add(socket);
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) return privateError(socket, 'invalid-message');
      let message; try { message = JSON.parse(raw); } catch { return privateError(socket, 'invalid-message'); }
      if (!message || typeof message.type !== 'string') return privateError(socket, 'invalid-message');
      const attachment = getAttachment(socket) || {};
      if (!attachment.authenticated) {
        if (message.type === 'auth-host') {
          const provided = await sha256(message.secret || '');
          if (!constantTimeEqual(provided, meta.hostDigest)) { privateError(socket, 'auth-failed'); close(socket, 4001, 'auth-failed'); return; }
          setAttachment(socket, { authenticated: true, role: 'host', participantId: 'host' });
          await apply(socket, { type: 'joined', role: 'host', participantId: 'host', at: now() }); await schedule(); return;
        }
        if (message.type === 'join') {
          let participantId; let credential;
          if (message.resume) {
            const digest = await sha256(message.resume);
            participantId = Object.keys(meta.resumeDigests).find(id => constantTimeEqual(meta.resumeDigests[id], digest));
            if (!participantId || meta.kickedDigests.some(item => constantTimeEqual(item, digest))) return privateError(socket, 'resume-invalid');
          } else {
            participantId = randomId(); credential = randomCredential();
            meta.resumeDigests[participantId] = await sha256(credential); await storage.put('meta', meta);
          }
          setAttachment(socket, { authenticated: true, role: 'listener', participantId });
          const accepted = await apply(socket, { type:'joined', role:'listener', participantId, actorId:participantId, name:message.name, at:now() });
          if (!accepted) return;
          if (credential) send(socket, { type:'resume-credential', credential });
          await schedule(); return;
        }
        return privateError(socket, 'authenticate-first');
      }
      const allowed = new Set(['request-submitted','request-accepted','request-reordered','request-declined','recording-started','lyrics-ready','recording-failed','song-ready','kicked','room-expired']);
      if (!allowed.has(message.type)) return privateError(socket, 'unknown-message');
      const event = { ...message, role: attachment.role, actorId: attachment.participantId, participantId: message.type === 'request-submitted' ? attachment.participantId : message.participantId, at: now() };
      if (message.type === 'request-submitted') event.requestId = randomId();
      if (message.type === 'song-ready') event.startedAt = now() + SONG_START_DELAY_MS;
      if (message.type === 'kicked') {
        const digest = meta.resumeDigests[message.participantId];
        if (digest) { meta.kickedDigests.push(digest); delete meta.resumeDigests[message.participantId]; await storage.put('meta', meta); }
      }
      await apply(socket, event);
    },
    async disconnect(socket) {
      await load(); const attachment = getAttachment(socket) || {}; sockets.delete(socket);
      if (attachment.authenticated) await apply(socket, { type:'left', role:attachment.role, participantId:attachment.participantId, actorId:attachment.participantId, at:now() });
      await schedule();
    },
    async checkAuthenticationTimeout(socket) { if (!getAttachment(socket)?.authenticated && now() - (getAttachment(socket)?.connectedAt || 0) >= AUTH_TIMEOUT_MS) close(socket, 4001, 'authentication-timeout'); },
    async alarm() {
      await load();
      if (now() < meta.absoluteDeadline && (!meta.emptyDeadline || now() < meta.emptyDeadline)) return setAlarm(Math.min(meta.absoluteDeadline, meta.emptyDeadline || Infinity));
      await apply(null, { type:'room-expired', role:'host', trustedAlarm:true, at:now() });
    },
    snapshot
  };
}
