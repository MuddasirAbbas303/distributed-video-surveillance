const jwt = require('jsonwebtoken');

class AuthenticationError extends Error {}

function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') {
    throw new AuthenticationError('Authentication required');
  }
  const match = /^Bearer ([^\s]+)$/.exec(authorizationHeader);
  if (!match) throw new AuthenticationError('Authentication required');
  return match[1];
}

function createTokenVerifier({ jwtSecret, sessionRegistry }) {
  function verifyToken(token) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new AuthenticationError('Authentication required');
    }

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    } catch {
      throw new AuthenticationError('Authentication required');
    }

    const claimsAreValid = payload
      && typeof payload.sub === 'string'
      && payload.sub.length > 0
      && payload.sub.length <= 100
      && typeof payload.role === 'string'
      && payload.role.length > 0
      && payload.role.length <= 100
      && typeof payload.jti === 'string'
      && payload.jti.length > 0
      && payload.jti.length <= 128
      && Number.isInteger(payload.iat)
      && payload.iat > 0
      && payload.iat <= Math.floor(Date.now() / 1000) + 60
      && Number.isInteger(payload.exp)
      && payload.exp > payload.iat;

    if (!claimsAreValid || !sessionRegistry.isSessionActive(payload.jti, {
      login: payload.sub,
      role: payload.role,
    })) {
      throw new AuthenticationError('Authentication required');
    }

    return payload;
  }

  function verifyAuthorizationHeader(authorizationHeader) {
    return verifyToken(extractBearerToken(authorizationHeader));
  }

  return { verifyAuthorizationHeader, verifyToken };
}

module.exports = { AuthenticationError, createTokenVerifier, extractBearerToken };
