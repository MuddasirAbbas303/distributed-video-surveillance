const jwt = require('jsonwebtoken');
const config = require('./config');
const sessionStore = require('./session-store');

class AuthenticationError extends Error {}

function verifyAccessToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new AuthenticationError('Authentication required');
  }

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw new AuthenticationError('Authentication required');
  }

  const claimsAreValid = payload
    && typeof payload.sub === 'string'
    && typeof payload.role === 'string'
    && typeof payload.jti === 'string'
    && Number.isInteger(payload.iat)
    && Number.isInteger(payload.exp);

  if (!claimsAreValid) {
    throw new AuthenticationError('Authentication required');
  }

  if (!sessionStore.isSessionActive(payload.jti, {
    login: payload.sub,
    role: payload.role,
  })) {
    throw new AuthenticationError('Authentication required');
  }

  return payload;
}

function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') {
    throw new AuthenticationError('Authentication required');
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorizationHeader);
  if (!match) throw new AuthenticationError('Authentication required');
  return match[1];
}

function requireAuthentication(request, response, next) {
  try {
    const token = extractBearerToken(request.get('authorization'));
    request.auth = verifyAccessToken(token);
    next();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      response.status(401).json({ error: 'Authentication required' });
      return;
    }
    next(error);
  }
}

module.exports = {
  AuthenticationError,
  extractBearerToken,
  requireAuthentication,
  verifyAccessToken,
};
