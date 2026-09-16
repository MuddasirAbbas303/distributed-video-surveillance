const express = require('express');
const { AuthenticationError } = require('./token-verifier');

function createCorsMiddleware(webOrigin) {
  return function hlsCors(request, response, next) {
    const requestOrigin = request.get('origin');
    response.vary('Origin');

    if (requestOrigin && requestOrigin !== webOrigin) {
      response.status(403).type('text').send('Origin not allowed');
      return;
    }

    if (requestOrigin === webOrigin) {
      response.setHeader('Access-Control-Allow-Origin', webOrigin);
      response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization');
    }

    if (request.method === 'OPTIONS') {
      const requestedMethod = request.get('access-control-request-method');
      const requestedHeaders = (request.get('access-control-request-headers') || '')
        .split(',')
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (requestOrigin !== webOrigin
        || !['GET', 'HEAD'].includes(requestedMethod)
        || requestedHeaders.some((header) => header !== 'authorization')) {
        response.status(403).type('text').send('CORS preflight rejected');
        return;
      }
      response.status(204).end();
      return;
    }

    next();
  };
}

function createHlsRouter({
  hlsDirectory,
  sessionRegistry,
  tokenVerifier,
  videoState,
  webOrigin,
}) {
  const router = express.Router();

  router.use(createCorsMiddleware(webOrigin));

  router.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');

    if (!sessionRegistry.isSynchronized()) {
      response.status(503).type('text').send('Authorization state unavailable');
      return;
    }

    try {
      request.auth = tokenVerifier.verifyAuthorizationHeader(request.get('authorization'));
    } catch (error) {
      if (error instanceof AuthenticationError) {
        response.status(401).type('text').send('Authentication required');
        return;
      }
      next(error);
      return;
    }

    if (!videoState.isVideoRunning()) {
      response.status(503).type('text').send('Video delivery is stopped');
      return;
    }
    next();
  });

  router.use(express.static(hlsDirectory, {
    fallthrough: true,
    setHeaders(response, filePath) {
      if (filePath.endsWith('.m3u8')) {
        response.type('application/vnd.apple.mpegurl');
      } else if (filePath.endsWith('.ts')) {
        response.type('video/mp2t');
      }
    },
  }));

  return router;
}

module.exports = { createCorsMiddleware, createHlsRouter };
