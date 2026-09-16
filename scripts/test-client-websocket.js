const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const config = require('../server-b/config');
const { COMMANDS, MESSAGE_TYPES } = require('../shared/protocol');

const includeLogout = process.argv.includes('--logout');
const commands = [
  COMMANDS.GET_STATUS,
  COMMANDS.STOP_VIDEO,
  COMMANDS.GET_STATUS,
  COMMANDS.START_VIDEO,
  COMMANDS.GET_STATUS,
];
if (includeLogout) commands.push(COMMANDS.LOGOUT);

async function login(loginName = 'admin', password = 'admin123') {
  const response = await fetch(`http://127.0.0.1:${config.port}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
  if (!response.ok) throw new Error(`Login failed with HTTP ${response.status}`);
  return response.json();
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const url = new URL(`ws://127.0.0.1:${config.port}/ws`);
    url.searchParams.set('token', token);
    const webSocket = new WebSocket(url);
    webSocket.once('open', () => resolve(webSocket));
    webSocket.once('error', reject);
  });
}

function sendCommand(webSocket, command) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      webSocket.off('message', onMessage);
      reject(new Error(`${command} timed out`));
    }, 6000);
    const onMessage = (data) => {
      const response = JSON.parse(data.toString());
      if (response.requestId !== requestId) return;
      clearTimeout(timeout);
      webSocket.off('message', onMessage);
      resolve(response);
    };
    webSocket.on('message', onMessage);
    webSocket.send(JSON.stringify({ type: MESSAGE_TYPES.COMMAND, requestId, command }));
  });
}

async function main() {
  const authentication = await login();
  const webSocket = await connect(authentication.token);
  try {
    for (const command of commands) {
      const response = await sendCommand(webSocket, command);
      console.log(JSON.stringify({ command, response }));
    }
  } finally {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.close();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`[client-ws-test] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { connect, login, sendCommand };
