const { MESSAGE_TYPES } = require('./protocol');

function parseJsonMessage(data) {
  try {
    return { ok: true, value: JSON.parse(data.toString()) };
  } catch {
    return { ok: false, error: 'Malformed JSON' };
  }
}

function validateCommandMessage(message, supportedCommands) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, error: 'Invalid message' };
  }
  if (message.type !== MESSAGE_TYPES.COMMAND) {
    return { ok: false, error: 'Invalid message type' };
  }
  if (typeof message.requestId !== 'string' || message.requestId.length === 0 || message.requestId.length > 128) {
    return { ok: false, error: 'Invalid requestId' };
  }
  if (typeof message.command !== 'string' || message.command.length === 0 || message.command.length > 100) {
    return { ok: false, error: 'Invalid command' };
  }
  if (supportedCommands && !supportedCommands.has(message.command)) {
    return { ok: false, error: 'Unsupported command' };
  }
  return { ok: true, value: message };
}

function validateResponseMessage(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.type === MESSAGE_TYPES.RESPONSE
    && typeof message.requestId === 'string'
    && typeof message.ok === 'boolean',
  );
}

function validateRequestId(message) {
  return typeof message?.requestId === 'string'
    && message.requestId.length > 0
    && message.requestId.length <= 128;
}

function validateSessionRecord(session) {
  const valid = session
    && typeof session === 'object'
    && !Array.isArray(session)
    && typeof session.jti === 'string'
    && session.jti.length > 0
    && session.jti.length <= 128
    && typeof session.login === 'string'
    && session.login.length > 0
    && session.login.length <= 100
    && typeof session.role === 'string'
    && session.role.length > 0
    && session.role.length <= 100
    && Number.isSafeInteger(session.expiresAt)
    && session.expiresAt > 0;

  return valid
    ? { ok: true, value: session }
    : { ok: false, error: 'Invalid session record' };
}

function validateSessionMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, error: 'Invalid message' };
  }
  if (!validateRequestId(message)) {
    return { ok: false, error: 'Invalid requestId' };
  }

  if (message.type === MESSAGE_TYPES.SESSION_SYNC) {
    if (!Array.isArray(message.sessions) || message.sessions.length > 1000) {
      return { ok: false, error: 'Invalid session snapshot' };
    }
    for (const session of message.sessions) {
      const validated = validateSessionRecord(session);
      if (!validated.ok) return validated;
    }
    return { ok: true, value: message };
  }

  if (message.type === MESSAGE_TYPES.SESSION_ACTIVATE) {
    const validated = validateSessionRecord(message.session);
    return validated.ok ? { ok: true, value: message } : validated;
  }

  if (message.type === MESSAGE_TYPES.SESSION_REVOKE) {
    if (typeof message.jti !== 'string' || message.jti.length === 0 || message.jti.length > 128) {
      return { ok: false, error: 'Invalid session identifier' };
    }
    return { ok: true, value: message };
  }

  return { ok: false, error: 'Invalid message type' };
}

module.exports = {
  parseJsonMessage,
  validateCommandMessage,
  validateResponseMessage,
  validateSessionMessage,
  validateSessionRecord,
};
