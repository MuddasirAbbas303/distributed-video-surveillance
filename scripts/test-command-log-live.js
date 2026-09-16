const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { COMMANDS } = require('../shared/protocol');
const { connect, login, sendCommand } = require('./test-client-websocket');

async function close(webSocket) {
  if (webSocket.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    webSocket.once('close', resolve);
    webSocket.close();
  });
}

async function main() {
  const authentication = await login('operator', 'operator123');
  const normalClient = await connect(authentication.token);
  try {
    const expectedStates = [true, false, false, true, true];
    const commands = [
      COMMANDS.GET_STATUS,
      COMMANDS.STOP_VIDEO,
      COMMANDS.GET_STATUS,
      COMMANDS.START_VIDEO,
      COMMANDS.GET_STATUS,
    ];
    for (let index = 0; index < commands.length; index += 1) {
      const response = await sendCommand(normalClient, commands[index]);
      assert.equal(response.ok, true);
      assert.equal(response.result.videoRunning, expectedStates[index]);
    }
  } finally {
    await close(normalClient);
  }

  const clients = await Promise.all(Array.from({ length: 8 }, () => connect(authentication.token)));
  try {
    const responses = await Promise.all(clients.map((client) => sendCommand(client, COMMANDS.GET_STATUS)));
    assert.ok(responses.every((response) => response.ok === true));
  } finally {
    await Promise.all(clients.map(close));
  }

  const logoutClient = await connect(authentication.token);
  const logoutResponse = await sendCommand(logoutClient, COMMANDS.LOGOUT);
  assert.equal(logoutResponse.ok, true);
  if (logoutClient.readyState !== WebSocket.CLOSED) {
    await new Promise((resolve) => logoutClient.once('close', resolve));
  }
  console.log('[command-log-live] Normal sequence, 8 concurrent clients, and logout passed');
}

void main().catch((error) => {
  console.error(`[command-log-live] ${error.stack || error.message}`);
  process.exitCode = 1;
});
