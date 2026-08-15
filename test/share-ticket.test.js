const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { issueShareTicket, verifyShareTicket } = require('../share-ticket');

const SECRET = 'placeholder-share-secret';
const SOURCE = 'https://cdn.example.test/audio/song.mp3?download=1';
const EXPIRES_AT = 2_000_000;

function changeCharacter(value, index) {
  const replacement = value[index] === 'A' ? 'B' : 'A';
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

function signedPayload(payload, secret = SECRET) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

test('issues and verifies a ticket at a fixed clock', () => {
  const ticket = issueShareTicket({ source: SOURCE, expiresAt: EXPIRES_AT, secret: SECRET });
  assert.deepEqual(verifyShareTicket(ticket, { now: EXPIRES_AT - 1, secret: SECRET }), {
    source: SOURCE,
    idempotencyKey: verifyShareTicket(ticket, { now: EXPIRES_AT - 1, secret: SECRET }).idempotencyKey
  });
});

test('derives a stable exact 24-character URL-safe idempotency key', () => {
  const ticket = issueShareTicket({ source: SOURCE, expiresAt: EXPIRES_AT, secret: SECRET });
  const first = verifyShareTicket(ticket, { now: 1_000_000, secret: SECRET });
  const second = verifyShareTicket(ticket, { now: 1_000_000, secret: SECRET });
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.match(first.idempotencyKey, /^[A-Za-z0-9_-]{24}$/);
});

test('rejects one-character payload and signature tampering', () => {
  const ticket = issueShareTicket({ source: SOURCE, expiresAt: EXPIRES_AT, secret: SECRET });
  const [payload, signature] = ticket.split('.');
  assert.throws(() => verifyShareTicket(`${changeCharacter(payload, 5)}.${signature}`, { now: 1, secret: SECRET }));
  assert.throws(() => verifyShareTicket(`${payload}.${changeCharacter(signature, 5)}`, { now: 1, secret: SECRET }));
});

test('rejects the wrong secret and expired tickets', () => {
  const ticket = issueShareTicket({ source: SOURCE, expiresAt: EXPIRES_AT, secret: SECRET });
  assert.throws(() => verifyShareTicket(ticket, { now: EXPIRES_AT - 1, secret: 'another-placeholder-secret' }));
  assert.throws(() => verifyShareTicket(ticket, { now: EXPIRES_AT, secret: SECRET }));
});

test('rejects malformed and oversized tickets', () => {
  for (const ticket of ['', '.', 'not-a-ticket', 'a.b.c', `${'a'.repeat(8193)}.signature`]) {
    assert.throws(() => verifyShareTicket(ticket, { now: 1, secret: SECRET }));
  }
});

test('rejects non-HTTPS and credential-bearing audio URLs', () => {
  assert.throws(() => issueShareTicket({ source: 'http://cdn.example.test/song.mp3', expiresAt: EXPIRES_AT, secret: SECRET }));
  assert.throws(() => issueShareTicket({ source: 'https://user:pass@cdn.example.test/song.mp3', expiresAt: EXPIRES_AT, secret: SECRET }));
  assert.throws(() => issueShareTicket({ source: 'https://@cdn.example.test/song.mp3', expiresAt: EXPIRES_AT, secret: SECRET }));
  assert.throws(() => verifyShareTicket(signedPayload({ v: 1, source: 'http://cdn.example.test/song.mp3', expiresAt: EXPIRES_AT }), { now: 1, secret: SECRET }));
  assert.throws(() => verifyShareTicket(signedPayload({ v: 1, source: 'https://user:pass@cdn.example.test/song.mp3', expiresAt: EXPIRES_AT }), { now: 1, secret: SECRET }));
});

test('rejects unexpected payload fields', () => {
  const ticket = signedPayload({ v: 1, source: SOURCE, expiresAt: EXPIRES_AT, token: 'unrelated-placeholder-token' });
  assert.throws(() => verifyShareTicket(ticket, { now: 1, secret: SECRET }));
});

test('does not include the secret or unrelated request credentials', () => {
  const unrelatedToken = 'unrelated-placeholder-token';
  const ticket = issueShareTicket({
    source: SOURCE,
    expiresAt: EXPIRES_AT,
    secret: SECRET,
    token: unrelatedToken
  });
  const [encodedPayload] = ticket.split('.');
  const decodedPayload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  assert.doesNotMatch(ticket, new RegExp(SECRET));
  assert.doesNotMatch(ticket, new RegExp(unrelatedToken));
  assert.doesNotMatch(decodedPayload, new RegExp(SECRET));
  assert.doesNotMatch(decodedPayload, new RegExp(unrelatedToken));
});
