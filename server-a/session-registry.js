function copySession(session) {
  return {
    jti: session.jti,
    login: session.login,
    role: session.role,
    expiresAt: session.expiresAt,
  };
}

function createSessionRegistry({ now = Date.now } = {}) {
  let synchronized = false;
  let sessions = new Map();

  function removeExpiredSessions() {
    const currentTime = now();
    for (const [jti, session] of sessions) {
      if (session.expiresAt <= currentTime) sessions.delete(jti);
    }
  }

  function replaceSessions(nextSessions) {
    const replacement = new Map();
    const currentTime = now();
    for (const session of nextSessions) {
      if (session.expiresAt > currentTime) {
        replacement.set(session.jti, copySession(session));
      }
    }
    sessions = replacement;
    synchronized = true;
    return sessions.size;
  }

  function activateSession(session) {
    if (session.expiresAt <= now()) {
      sessions.delete(session.jti);
      return false;
    }
    sessions.set(session.jti, copySession(session));
    return true;
  }

  function revokeSession(jti) {
    return sessions.delete(jti);
  }

  function getSession(jti) {
    if (!synchronized) return null;
    const session = sessions.get(jti);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(jti);
      return null;
    }
    return copySession(session);
  }

  function isSessionActive(jti, expected = {}) {
    const session = getSession(jti);
    if (!session) return false;
    if (expected.login && session.login !== expected.login) return false;
    if (expected.role && session.role !== expected.role) return false;
    return true;
  }

  function markUnsynchronized() {
    synchronized = false;
    sessions.clear();
  }

  function isSynchronized() {
    return synchronized;
  }

  function getActiveSessionCount() {
    removeExpiredSessions();
    return sessions.size;
  }

  return {
    activateSession,
    getActiveSessionCount,
    getSession,
    isSessionActive,
    isSynchronized,
    markUnsynchronized,
    replaceSessions,
    revokeSession,
  };
}

module.exports = { createSessionRegistry };
