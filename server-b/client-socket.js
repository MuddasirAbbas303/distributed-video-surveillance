const { WebSocket, WebSocketServer } = require('ws');
const { CLIENT_COMMANDS, COMMANDS, MESSAGE_TYPES } = require('../shared/protocol');
const { canExecuteCommand } = require('../shared/permissions');
const { parseJsonMessage, validateCommandMessage } = require('../shared/validation');
const { CommandLogWriteError } = require('./command-logger');

function createResponse(requestId, ok, value) {
  return ok
    ? { type: MESSAGE_TYPES.RESPONSE, requestId, ok: true, result: value }
    : { type: MESSAGE_TYPES.RESPONSE, requestId, ok: false, error: value };
}

function sendJson(webSocket, value, callback) {
  if (webSocket.readyState !== WebSocket.OPEN) return;
  webSocket.send(JSON.stringify(value), callback);
}

function attachClientSocket(server, {
  commandLogger,
  sessionStore,
  verifyAccessToken,
  videoServerSocket,
}) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  function rejectUpgrade(socket) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  }

  server.on('upgrade', (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url, 'http://127.0.0.1');
    } catch {
      rejectUpgrade(socket);
      return;
    }

    if (requestUrl.pathname !== '/ws') {
      rejectUpgrade(socket);
      return;
    }

    let identity;
    try {
      identity = verifyAccessToken(requestUrl.searchParams.get('token'));
    } catch {
      rejectUpgrade(socket);
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, identity);
    });
  });

  webSocketServer.on('connection', (webSocket, identity) => {
    const connectionIdentity = Object.freeze({
      jti: identity.jti,
      login: identity.sub,
      role: identity.role,
    });

    async function handleMessage(data) {
      let responseRequestId = null;
      try {
        if (!sessionStore.isSessionActive(connectionIdentity.jti, {
          login: connectionIdentity.login,
          role: connectionIdentity.role,
        })) {
          const parsed = parseJsonMessage(data);
          const requestId = parsed.ok && typeof parsed.value?.requestId === 'string'
            ? parsed.value.requestId
            : null;
          responseRequestId = requestId;
          await commandLogger.log({
            user: connectionIdentity.login,
            message: 'SESSION_REJECTED',
            requestId,
            status: 'rejected',
          });
          sendJson(webSocket, createResponse(requestId, false, 'Authentication required'), () => {
            webSocket.close(1008, 'Session expired or revoked');
          });
          return;
        }

        const parsed = parseJsonMessage(data);
        if (!parsed.ok) {
          await commandLogger.log({
            user: connectionIdentity.login,
            message: 'MALFORMED_MESSAGE',
            status: 'rejected',
            error: parsed.error,
          });
          sendJson(webSocket, createResponse(null, false, parsed.error));
          return;
        }

        const validated = validateCommandMessage(parsed.value, CLIENT_COMMANDS);
        if (!validated.ok) {
          const requestId = typeof parsed.value?.requestId === 'string'
            ? parsed.value.requestId
            : null;
          responseRequestId = requestId;
          await commandLogger.log({
            user: connectionIdentity.login,
            message: 'INVALID_COMMAND',
            requestId,
            status: 'rejected',
            error: validated.error,
          });
          sendJson(webSocket, createResponse(requestId, false, validated.error));
          return;
        }

        const { command, requestId } = validated.value;
        responseRequestId = requestId;
        await commandLogger.log({
          user: connectionIdentity.login,
          message: command,
          requestId,
          status: 'received',
        });

        if (!canExecuteCommand(connectionIdentity.role, command)) {
          await commandLogger.log({
            user: connectionIdentity.login,
            message: command,
            requestId,
            status: 'forbidden',
          });
          sendJson(webSocket, createResponse(requestId, false, 'Forbidden'));
          return;
        }

        if (command === COMMANDS.LOGOUT) {
          sessionStore.revokeSession(connectionIdentity.jti);
          await videoServerSocket.revokeSession(connectionIdentity.jti);
          await commandLogger.log({
            user: connectionIdentity.login,
            message: command,
            requestId,
            status: 'succeeded',
          });
          sendJson(webSocket, createResponse(requestId, true, { loggedOut: true }), () => {
            webSocket.close(1000, 'Logged out');
          });
          return;
        }

        await commandLogger.log({
          user: connectionIdentity.login,
          message: command,
          requestId,
          status: 'forwarded',
        });

        try {
          const result = await videoServerSocket.sendCommand(command);
          await commandLogger.log({
            user: connectionIdentity.login,
            message: command,
            requestId,
            status: 'succeeded',
          });
          sendJson(webSocket, createResponse(requestId, true, result));
        } catch (error) {
          if (error instanceof CommandLogWriteError) throw error;
          const safeError = ['Video server unavailable', 'Video server command timed out'].includes(error.message)
            ? error.message
            : 'Command failed';
          await commandLogger.log({
            user: connectionIdentity.login,
            message: command,
            requestId,
            status: 'failed',
            error: safeError,
          });
          sendJson(webSocket, createResponse(requestId, false, safeError));
        }
      } catch (error) {
        if (error instanceof CommandLogWriteError) {
          console.error('[server-b] Audit log write failed; request processing stopped');
          sendJson(webSocket, createResponse(responseRequestId, false, 'Audit log unavailable'));
          return;
        }
        console.error(`[server-b] Client command processing failed: ${error.message}`);
        sendJson(webSocket, createResponse(responseRequestId, false, 'Command failed'));
      }
    }

    webSocket.on('message', (data) => {
      void handleMessage(data);
    });

    webSocket.on('error', (error) => {
      if (error.code !== 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
        console.error(`[server-b] Client WebSocket error: ${error.message}`);
      }
    });
  });

  async function close() {
    for (const client of webSocketServer.clients) client.close(1001, 'Server shutting down');
    await new Promise((resolve) => {
      const forceTimer = setTimeout(() => {
        for (const client of webSocketServer.clients) client.terminate();
      }, 1000);
      webSocketServer.close(() => {
        clearTimeout(forceTimer);
        resolve();
      });
    });
  }

  return { close, webSocketServer };
}

module.exports = { attachClientSocket };
