const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { attachClientSocket } = require('../server-b/client-socket');
const { CommandLogWriteError } = require('../server-b/command-logger');
const { canExecuteCommand } = require('../shared/permissions');
const { COMMANDS, MESSAGE_TYPES } = require('../shared/protocol');

function sendCommand(webSocket, command) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${command} timed out`)), 2000);
    const onMessage = (data) => {
      const response = JSON.parse(data.toString());
      if (response.requestId !== requestId) return;
      clearTimeout(timeout);
      webSocket.off('message', onMessage);
      resolve({ requestId, response });
    };
    webSocket.on('message', onMessage);
    webSocket.send(JSON.stringify({ type: MESSAGE_TYPES.COMMAND, requestId, command }));
  });
}

function connect(port, role) {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${role}`);
    webSocket.once('open', () => resolve(webSocket));
    webSocket.once('error', reject);
  });
}

async function main() {
  assert.equal(canExecuteCommand('viewer', COMMANDS.GET_STATUS), true);
  assert.equal(canExecuteCommand('viewer', COMMANDS.START_VIDEO), false);
  assert.equal(canExecuteCommand('viewer', COMMANDS.STOP_VIDEO), false);
  assert.equal(canExecuteCommand('operator', COMMANDS.GET_STATUS), true);
  assert.equal(canExecuteCommand('operator', COMMANDS.START_VIDEO), true);
  assert.equal(canExecuteCommand('operator', COMMANDS.STOP_VIDEO), true);
  assert.equal(canExecuteCommand('unsupported-role', COMMANDS.GET_STATUS), false);
  assert.equal(canExecuteCommand('unsupported-role', COMMANDS.START_VIDEO), false);
  assert.equal(canExecuteCommand('unsupported-role', COMMANDS.LOGOUT), true);
  assert.equal(canExecuteCommand(undefined, COMMANDS.GET_STATUS), false);
  assert.equal(canExecuteCommand(null, COMMANDS.STOP_VIDEO), false);
  assert.equal(canExecuteCommand({}, COMMANDS.START_VIDEO), false);

  const forwarded = [];
  const logged = [];
  const revoked = [];
  const server = http.createServer();
  const clientSocket = attachClientSocket(server, {
    commandLogger: { async log(entry) { logged.push(entry); } },
    sessionStore: {
      isSessionActive() { return true; },
      revokeSession(jti) { revoked.push(jti); return true; },
    },
    verifyAccessToken(role) {
      return { jti: `session-${role}`, sub: `${role}-user`, role };
    },
    videoServerSocket: {
      async revokeSession() { return true; },
      async sendCommand(command) {
        forwarded.push(command);
        return { videoRunning: command !== COMMANDS.STOP_VIDEO };
      },
    },
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  try {
    const viewer = await connect(port, 'viewer');
    const deniedStart = await sendCommand(viewer, COMMANDS.START_VIDEO);
    assert.deepEqual(deniedStart.response, {
      type: MESSAGE_TYPES.RESPONSE,
      requestId: deniedStart.requestId,
      ok: false,
      error: 'Forbidden',
    });
    assert.equal(viewer.readyState, WebSocket.OPEN);

    const viewerStatus = await sendCommand(viewer, COMMANDS.GET_STATUS);
    assert.equal(viewerStatus.response.ok, true);
    const deniedStop = await sendCommand(viewer, COMMANDS.STOP_VIDEO);
    assert.equal(deniedStop.response.error, 'Forbidden');
    assert.equal(viewer.readyState, WebSocket.OPEN);
    assert.deepEqual(forwarded, [COMMANDS.GET_STATUS]);

    for (const denied of [deniedStart, deniedStop]) {
      const statuses = logged
        .filter(({ requestId }) => requestId === denied.requestId)
        .map(({ status }) => status);
      assert.deepEqual(statuses, ['received', 'forbidden']);
      assert.equal(statuses.includes('forwarded'), false);
    }

    const viewerLogout = await sendCommand(viewer, COMMANDS.LOGOUT);
    assert.equal(viewerLogout.response.ok, true);
    await new Promise((resolve) => viewer.once('close', resolve));

    const operator = await connect(port, 'operator');
    assert.equal((await sendCommand(operator, COMMANDS.STOP_VIDEO)).response.ok, true);
    assert.equal((await sendCommand(operator, COMMANDS.START_VIDEO)).response.ok, true);
    assert.equal((await sendCommand(operator, COMMANDS.GET_STATUS)).response.ok, true);
    const operatorLogout = await sendCommand(operator, COMMANDS.LOGOUT);
    assert.equal(operatorLogout.response.ok, true);
    await new Promise((resolve) => operator.once('close', resolve));

    const unsupported = await connect(port, 'unsupported-role');
    const unsupportedStatus = await sendCommand(unsupported, COMMANDS.GET_STATUS);
    assert.equal(unsupportedStatus.response.error, 'Forbidden');
    const unsupportedLogout = await sendCommand(unsupported, COMMANDS.LOGOUT);
    assert.equal(unsupportedLogout.response.ok, true);
    await new Promise((resolve) => unsupported.once('close', resolve));

    assert.deepEqual(forwarded, [
      COMMANDS.GET_STATUS,
      COMMANDS.STOP_VIDEO,
      COMMANDS.START_VIDEO,
      COMMANDS.GET_STATUS,
    ]);
    assert.equal(revoked.length, 3);
  } finally {
    await clientSocket.close();
    await new Promise((resolve) => server.close(resolve));
  }

  const forwardedAfterLogFailure = [];
  const failureServer = http.createServer();
  const failureSocket = attachClientSocket(failureServer, {
    commandLogger: {
      async log() {
        throw new CommandLogWriteError(new Error('controlled test failure'));
      },
    },
    sessionStore: { isSessionActive() { return true; } },
    verifyAccessToken() {
      return { jti: 'failure-session', sub: 'operator-user', role: 'operator' };
    },
    videoServerSocket: {
      async sendCommand(command) {
        forwardedAfterLogFailure.push(command);
        return { videoRunning: true };
      },
    },
  });
  await new Promise((resolve, reject) => {
    failureServer.once('error', reject);
    failureServer.listen(0, '127.0.0.1', resolve);
  });
  try {
    const operator = await connect(failureServer.address().port, 'operator');
    const rejected = await sendCommand(operator, COMMANDS.START_VIDEO);
    assert.equal(rejected.response.ok, false);
    assert.equal(rejected.response.error, 'Audit log unavailable');
    assert.deepEqual(forwardedAfterLogFailure, []);
    operator.close();
  } finally {
    await failureSocket.close();
    await new Promise((resolve) => failureServer.close(resolve));
  }

  console.log('[rbac-test] Permissions, forwarding gate, forbidden logging, socket continuity, unknown-role denial, and audit-write fail-closed checks passed');
}

void main().catch((error) => {
  console.error(`[rbac-test] ${error.stack || error.message}`);
  process.exitCode = 1;
});
