const http = require('node:http');
const express = require('express');
const config = require('./config');
const { createAuthRouter } = require('./auth-routes');
const { requireAuthentication, verifyAccessToken } = require('./auth-middleware');
const { attachClientSocket } = require('./client-socket');
const { createCommandLogger } = require('./command-logger');
const sessionStore = require('./session-store');
const { VideoServerSocket } = require('./video-server-socket');

let server;
let shuttingDown = false;
let clientSocket;
const commandLogger = createCommandLogger(config.commandLogFile, config.logHmacSecret);
const videoServerSocket = new VideoServerSocket({
  controlUrl: config.serverAControlUrl,
  getActiveSessions: sessionStore.getActiveSessions,
  secret: config.internalWsSecret,
});

function createApp() {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.use('/auth', createAuthRouter({
    onSessionActivated: (session) => videoServerSocket.activateSession(session),
  }));

  app.get('/protected', requireAuthentication, (request, response) => {
    response.json({
      authenticated: true,
      user: { login: request.auth.sub, role: request.auth.role },
    });
  });

  app.get('/vendor/hls.min.js', (_request, response) => {
    response.sendFile(config.hlsClientFile);
  });

  app.get('/docs', (_request, response) => {
    response.sendFile('docs.html', { root: config.publicDirectory });
  });

  app.use(express.static(config.publicDirectory, {
    index: 'index.html',
    maxAge: 0,
  }));

  app.use((error, _request, response, next) => {
    if (error?.type === 'entity.parse.failed') {
      response.status(400).json({ error: 'Malformed JSON request' });
      return;
    }
    next(error);
  });

  app.use((error, _request, response, _next) => {
    console.error(`[server-b] Request failed: ${error.message}`);
    response.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[server-b] Shutting down...');
  if (clientSocket) await clientSocket.close();
  await videoServerSocket.stop();
  try {
    await commandLogger.flush();
  } catch {
    exitCode = 1;
  }
  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  process.exitCode = exitCode;
}

async function main() {
  await commandLogger.initialize();
  server = http.createServer(createApp());
  clientSocket = attachClientSocket(server, {
    commandLogger,
    sessionStore,
    verifyAccessToken,
    videoServerSocket,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  console.log(`[server-b] HTTP server listening on http://127.0.0.1:${config.port}`);
  videoServerSocket.start();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('uncaughtException', (error) => {
  console.error(`[server-b] Fatal error: ${error.stack || error.message}`);
  void shutdown(1);
});
process.once('unhandledRejection', (error) => {
  console.error(`[server-b] Fatal rejection: ${error.stack || error}`);
  void shutdown(1);
});

if (require.main === module) {
  void main().catch((error) => {
    console.error(`[server-b] Startup failed: ${error.stack || error.message}`);
    void shutdown(1);
  });
}

module.exports = { createApp };
