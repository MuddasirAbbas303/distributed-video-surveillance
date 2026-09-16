const { timingSafeEqual } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');
const { COMMANDS, MESSAGE_TYPES, SUPPORTED_COMMANDS } = require('../shared/protocol');
const {
  parseJsonMessage,
  validateCommandMessage,
  validateSessionMessage,
} = require('../shared/validation');

function secretsMatch(received, expected) {
  if (typeof received !== 'string') return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length
    && timingSafeEqual(receivedBuffer, expectedBuffer);
}

function createResponse(requestId, ok, value) {
  return ok
    ? { type: MESSAGE_TYPES.RESPONSE, requestId, ok: true, result: value }
    : { type: MESSAGE_TYPES.RESPONSE, requestId, ok: false, error: value };
}

function executeCommand(command, videoState) {
  switch (command) {
    case COMMANDS.START_VIDEO:
      return videoState.startVideo();
    case COMMANDS.STOP_VIDEO:
      return videoState.stopVideo();
    case COMMANDS.GET_STATUS:
      return videoState.getStatus();
    default:
      return null;
  }
}

function attachManagementSocket(server, { secret, sessionRegistry, videoState }) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  let currentClient = null;

  function rejectUpgrade(socket, status = '401 Unauthorized') {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  }

  function sendResponse(webSocket, response) {
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(JSON.stringify(response));
    }
  }

  server.on('upgrade', (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url, 'http://127.0.0.1');
    } catch {
      rejectUpgrade(socket);
      return;
    }

    if (requestUrl.pathname !== '/internal/control'
      || !secretsMatch(requestUrl.searchParams.get('secret'), secret)) {
      rejectUpgrade(socket);
      return;
    }
    if (currentClient && currentClient.readyState !== WebSocket.CLOSED) {
      rejectUpgrade(socket, '409 Conflict');
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket);
    });
  });

  webSocketServer.on('connection', (webSocket) => {
    currentClient = webSocket;
    sessionRegistry.markUnsynchronized();
    console.log('[server-a] Internal control client connected');

    webSocket.on('message', (data) => {
      const parsed = parseJsonMessage(data);
      if (!parsed.ok) {
        sendResponse(webSocket, createResponse(null, false, parsed.error));
        return;
      }

      if (parsed.value?.type === MESSAGE_TYPES.COMMAND) {
        const validated = validateCommandMessage(parsed.value, SUPPORTED_COMMANDS);
        if (!validated.ok) {
          const requestId = typeof parsed.value?.requestId === 'string' ? parsed.value.requestId : null;
          sendResponse(webSocket, createResponse(requestId, false, validated.error));
          return;
        }

        const { requestId, command } = validated.value;
        const result = executeCommand(command, videoState);
        sendResponse(webSocket, createResponse(requestId, true, result));
        return;
      }

      const validated = validateSessionMessage(parsed.value);
      if (!validated.ok) {
        if ([
          MESSAGE_TYPES.SESSION_ACTIVATE,
          MESSAGE_TYPES.SESSION_REVOKE,
          MESSAGE_TYPES.SESSION_SYNC,
        ].includes(parsed.value?.type)) {
          sessionRegistry.markUnsynchronized();
        }
        const requestId = typeof parsed.value?.requestId === 'string' ? parsed.value.requestId : null;
        sendResponse(webSocket, createResponse(requestId, false, validated.error));
        return;
      }

      const { requestId, type } = validated.value;
      if (type === MESSAGE_TYPES.SESSION_SYNC) {
        const activeSessions = sessionRegistry.replaceSessions(validated.value.sessions);
        console.log(`[server-a] Session synchronization completed: ${activeSessions} active sessions`);
        sendResponse(webSocket, createResponse(requestId, true, { activeSessions }));
        return;
      }

      if (!sessionRegistry.isSynchronized()) {
        sendResponse(webSocket, createResponse(requestId, false, 'Authorization state unavailable'));
        return;
      }

      if (type === MESSAGE_TYPES.SESSION_ACTIVATE) {
        sessionRegistry.activateSession(validated.value.session);
      } else {
        sessionRegistry.revokeSession(validated.value.jti);
      }
      sendResponse(webSocket, createResponse(requestId, true, {
        activeSessions: sessionRegistry.getActiveSessionCount(),
      }));
    });

    webSocket.once('close', () => {
      if (currentClient !== webSocket) return;
      currentClient = null;
      sessionRegistry.markUnsynchronized();
      console.log('[server-a] Internal control client disconnected');
    });

    webSocket.on('error', (error) => {
      if (error.code !== 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
        console.error(`[server-a] Internal control connection error: ${error.message}`);
      }
    });
  });

  async function close() {
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise((resolve) => webSocketServer.close(resolve));
  }

  return { close, webSocketServer };
}

module.exports = { attachManagementSocket, executeCommand, secretsMatch };
