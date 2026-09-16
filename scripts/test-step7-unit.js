const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createSessionRegistry } = require('../server-a/session-registry');
const { createTokenVerifier } = require('../server-a/token-verifier');

const secret = 'step-7-unit-test-secret';
let currentTime = Date.now();
const now = () => currentTime;
const registry = createSessionRegistry({ now });

assert.equal(registry.isSynchronized(), false);
assert.equal(registry.isSessionActive('session-a'), false);

const sessionA = {
  jti: 'session-a',
  login: 'admin',
  role: 'operator',
  expiresAt: currentTime + 60_000,
};
const sessionB = {
  jti: 'session-b',
  login: 'admin',
  role: 'operator',
  expiresAt: currentTime + 60_000,
};

assert.equal(registry.replaceSessions([sessionA]), 1);
assert.equal(registry.isSynchronized(), true);
assert.equal(registry.isSessionActive('session-a', { login: 'admin', role: 'operator' }), true);
assert.equal(registry.activateSession(sessionA), true);
assert.equal(registry.getActiveSessionCount(), 1);
assert.equal(registry.revokeSession('unknown-session'), false);
assert.equal(registry.activateSession(sessionB), true);
assert.equal(registry.getActiveSessionCount(), 2);
assert.equal(registry.replaceSessions([sessionB]), 1);
assert.equal(registry.isSessionActive('session-a'), false);

const issuedAt = Math.floor(currentTime / 1000);
const verifier = createTokenVerifier({ jwtSecret: secret, sessionRegistry: registry });
const validToken = jwt.sign(
  { role: sessionB.role, jti: sessionB.jti, iat: issuedAt },
  secret,
  { algorithm: 'HS256', expiresIn: 60, subject: sessionB.login },
);
assert.equal(verifier.verifyToken(validToken).jti, sessionB.jti);

const unknownToken = jwt.sign(
  { role: 'operator', jti: 'unknown', iat: issuedAt },
  secret,
  { algorithm: 'HS256', expiresIn: 60, subject: 'admin' },
);
assert.throws(() => verifier.verifyToken(unknownToken));

const mismatchedToken = jwt.sign(
  { role: 'viewer', jti: sessionB.jti, iat: issuedAt },
  secret,
  { algorithm: 'HS256', expiresIn: 60, subject: 'admin' },
);
assert.throws(() => verifier.verifyToken(mismatchedToken));
assert.throws(() => verifier.verifyToken('malformed-token'));

currentTime += 60_001;
assert.equal(registry.isSessionActive(sessionB.jti), false);

const expiredRegistry = createSessionRegistry();
expiredRegistry.replaceSessions([{
  ...sessionA,
  expiresAt: Date.now() + 60_000,
}]);
const expiredVerifier = createTokenVerifier({ jwtSecret: secret, sessionRegistry: expiredRegistry });
const expiredToken = jwt.sign(
  { role: sessionA.role, jti: sessionA.jti },
  secret,
  { algorithm: 'HS256', expiresIn: -1, subject: sessionA.login },
);
assert.throws(() => expiredVerifier.verifyToken(expiredToken));

registry.markUnsynchronized();
assert.equal(registry.isSynchronized(), false);
assert.equal(registry.getActiveSessionCount(), 0);

console.log('[step7-unit] Session registry and JWT verifier checks passed');
