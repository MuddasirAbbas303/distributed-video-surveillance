const { randomUUID } = require('node:crypto');

const sessions = new Map();

function createSession({ login, role, lifetimeSeconds = 3600 }) {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + lifetimeSeconds * 1000);
  const session = {
    jti: randomUUID(),
    login,
    role,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    revoked: false,
  };

  sessions.set(session.jti, session);
  return { ...session };
}

function getSession(jti) {
  const session = sessions.get(jti);
  if (!session) return null;

  if (Date.parse(session.expiresAt) <= Date.now()) {
    sessions.delete(jti);
    return null;
  }

  return { ...session };
}

function isSessionActive(jti, expected = {}) {
  const session = getSession(jti);
  if (!session || session.revoked) return false;
  if (expected.login && session.login !== expected.login) return false;
  if (expected.role && session.role !== expected.role) return false;
  return true;
}

function revokeSession(jti) {
  const session = sessions.get(jti);
  if (!session) return false;
  session.revoked = true;
  return true;
}

function toSynchronizationRecord(session) {
  return {
    jti: session.jti,
    login: session.login,
    role: session.role,
    expiresAt: Date.parse(session.expiresAt),
  };
}

function getActiveSessions() {
  const activeSessions = [];
  for (const [jti, session] of sessions) {
    if (session.revoked || Date.parse(session.expiresAt) <= Date.now()) {
      sessions.delete(jti);
      continue;
    }
    activeSessions.push(toSynchronizationRecord(session));
  }
  return activeSessions;
}

function clearSessions() {
  sessions.clear();
}

function getSessionCount() {
  return sessions.size;
}

module.exports = {
  clearSessions,
  createSession,
  getActiveSessions,
  getSession,
  getSessionCount,
  isSessionActive,
  revokeSession,
  toSynchronizationRecord,
};
