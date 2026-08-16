const crypto = require('node:crypto');

const VERSION = 1;
const MAX_TICKET_LENGTH = 8192;
const INVALID_TICKET = 'Invalid share ticket.';

/** @returns {Error} */
function invalidTicket() {
  return new Error(INVALID_TICKET);
}

/** @param {unknown} secret @returns {secret is string} */
function validSecret(secret) {
  return typeof secret === 'string' && secret.length > 0;
}

/** @param {unknown} source @returns {source is string} */
function validSource(source) {
  if (typeof source !== 'string' || !source) return false;
  try {
    const url = new URL(source);
    return url.protocol === 'https:'
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !/^https:\/\/[^/?#]*@/i.test(source);
  } catch {
    return false;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} payload
 * @returns {payload is import('./types/contracts').ShareTicketPayload}
 */
function validPayload(payload) {
  if (!isRecord(payload)) return false;
  const keys = Object.keys(payload).sort();
  return keys.length === 3
    && keys[0] === 'expiresAt'
    && keys[1] === 'source'
    && keys[2] === 'v'
    && payload.v === VERSION
    && Number.isSafeInteger(payload.expiresAt)
    && validSource(payload.source);
}

/** @param {string} encodedPayload @param {string} secret */
function signatureFor(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest();
}

/**
 * @param {import('./types/contracts').IssueShareTicketOptions} [options]
 * @returns {string}
 */
function issueShareTicket({ source, expiresAt, secret } = {}) {
  const payload = { v: VERSION, source, expiresAt };
  if (!validSecret(secret) || !validPayload(payload)) throw invalidTicket();

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signatureFor(encodedPayload, secret).toString('base64url');
  const ticket = `${encodedPayload}.${signature}`;
  if (ticket.length > MAX_TICKET_LENGTH) throw invalidTicket();
  return ticket;
}

/**
 * @param {unknown} ticket
 * @param {import('./types/contracts').VerifyShareTicketOptions} [options]
 * @returns {import('./types/contracts').VerifiedShareTicket}
 */
function verifyShareTicket(ticket, { now, secret } = {}) {
  if (typeof ticket !== 'string' || !ticket || ticket.length > MAX_TICKET_LENGTH || !validSecret(secret) || typeof now !== 'number' || !Number.isSafeInteger(now)) {
    throw invalidTicket();
  }

  const parts = ticket.split('.');
  if (parts.length !== 2) throw invalidTicket();
  const [encodedPayload, encodedSignature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(encodedPayload) || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) throw invalidTicket();

  let suppliedSignature;
  try {
    suppliedSignature = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw invalidTicket();
  }
  const expectedSignature = signatureFor(encodedPayload, secret);
  if (suppliedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) {
    throw invalidTicket();
  }
  if (suppliedSignature.toString('base64url') !== encodedSignature) throw invalidTicket();

  /** @type {unknown} */
  let payload;
  try {
    const payloadBytes = Buffer.from(encodedPayload, 'base64url');
    if (payloadBytes.toString('base64url') !== encodedPayload) throw invalidTicket();
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw invalidTicket();
  }
  if (!validPayload(payload) || payload.expiresAt <= now) throw invalidTicket();

  return {
    source: payload.source,
    idempotencyKey: suppliedSignature.subarray(0, 18).toString('base64url')
  };
}

module.exports = { issueShareTicket, verifyShareTicket };
