const crypto = require('node:crypto');

const GENESIS_HASH = 'GENESIS';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_FIELDS = new Set([
  'timestamp',
  'user',
  'message',
  'requestId',
  'status',
  'error',
  'previousHash',
  'hash',
]);

class CommandLogIntegrityError extends Error {
  constructor(entry, reason) {
    super(`Command log integrity verification failed at entry ${entry}: ${reason}`);
    this.name = 'CommandLogIntegrityError';
    this.entry = entry;
    this.reason = reason;
  }
}

function canonicalizeEntry(entry) {
  return JSON.stringify({
    timestamp: entry.timestamp,
    user: entry.user,
    message: entry.message,
    requestId: Object.hasOwn(entry, 'requestId') ? entry.requestId : null,
    status: entry.status,
    error: Object.hasOwn(entry, 'error') ? entry.error : null,
    previousHash: entry.previousHash,
  });
}

function computeEntryHash(entry, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(canonicalizeEntry(entry), 'utf8')
    .digest('hex');
}

function hashesMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (!HASH_PATTERN.test(actual) || !HASH_PATTERN.test(expected)) return false;
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function validateEntryShape(entry, entryNumber) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new CommandLogIntegrityError(entryNumber, 'entry must be a JSON object');
  }

  const unexpectedField = Object.keys(entry).find((field) => !ALLOWED_FIELDS.has(field));
  if (unexpectedField) {
    throw new CommandLogIntegrityError(entryNumber, `unexpected field ${unexpectedField}`);
  }

  for (const field of ['timestamp', 'user', 'message', 'status', 'previousHash', 'hash']) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      throw new CommandLogIntegrityError(entryNumber, `missing or invalid ${field}`);
    }
  }

  for (const field of ['requestId', 'error']) {
    if (Object.hasOwn(entry, field) && typeof entry[field] !== 'string') {
      throw new CommandLogIntegrityError(entryNumber, `invalid ${field}`);
    }
  }

  if (!HASH_PATTERN.test(entry.hash)) {
    throw new CommandLogIntegrityError(entryNumber, 'invalid hash encoding');
  }
}

function verifyCommandLogContent(contents, secret) {
  const lines = contents.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let expectedPreviousHash = GENESIS_HASH;

  for (let index = 0; index < lines.length; index += 1) {
    const entryNumber = index + 1;
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      throw new CommandLogIntegrityError(entryNumber, 'invalid JSON');
    }

    validateEntryShape(entry, entryNumber);
    if (entry.previousHash !== expectedPreviousHash) {
      throw new CommandLogIntegrityError(entryNumber, 'previousHash chain mismatch');
    }

    const expectedHash = computeEntryHash(entry, secret);
    if (!hashesMatch(entry.hash, expectedHash)) {
      throw new CommandLogIntegrityError(entryNumber, 'HMAC mismatch');
    }
    expectedPreviousHash = entry.hash;
  }

  return {
    count: lines.length,
    lastHash: expectedPreviousHash,
  };
}

module.exports = {
  CommandLogIntegrityError,
  GENESIS_HASH,
  canonicalizeEntry,
  computeEntryHash,
  verifyCommandLogContent,
};
