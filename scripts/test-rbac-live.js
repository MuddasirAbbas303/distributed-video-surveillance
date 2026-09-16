const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const WebSocket = require('ws');
const config = require('../server-b/config');
const { COMMANDS } = require('../shared/protocol');
const { connect, login, sendCommand } = require('./test-client-websocket');

const projectRoot = path.resolve(__dirname, '..');
const hlsUrl = 'http://127.0.0.1:3001/video/stream.m3u8';

async function hlsStatus(token) {
  const response = await fetch(hlsUrl, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.status;
}

async function logout(webSocket) {
  const response = await sendCommand(webSocket, COMMANDS.LOGOUT);
  assert.equal(response.ok, true);
  await new Promise((resolve) => webSocket.once('close', resolve));
}

async function segmentNewestMtime() {
  const hlsDirectory = path.join(projectRoot, 'runtime', 'hls');
  const names = (await fs.readdir(hlsDirectory)).filter((name) => name.endsWith('.ts'));
  const stats = await Promise.all(names.map((name) => fs.stat(path.join(hlsDirectory, name))));
  return Math.max(...stats.map(({ mtimeMs }) => mtimeMs));
}

async function commandStatuses(requestId) {
  const entries = (await fs.readFile(config.commandLogFile, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
  return entries
    .filter((entry) => entry.requestId === requestId)
    .map((entry) => entry.status);
}

async function main() {
  const viewerLogin = await login('viewer', 'viewer123');
  assert.equal(viewerLogin.user.role, 'viewer');
  assert.equal(await hlsStatus(viewerLogin.token), 200);
  const viewer = await connect(viewerLogin.token);

  const initialStatus = await sendCommand(viewer, COMMANDS.GET_STATUS);
  assert.equal(initialStatus.ok, true);
  assert.equal(initialStatus.result.videoRunning, true);

  const deniedStart = await sendCommand(viewer, COMMANDS.START_VIDEO);
  assert.equal(deniedStart.ok, false);
  assert.equal(deniedStart.error, 'Forbidden');
  assert.equal(viewer.readyState, WebSocket.OPEN);

  const deniedStop = await sendCommand(viewer, COMMANDS.STOP_VIDEO);
  assert.equal(deniedStop.ok, false);
  assert.equal(deniedStop.error, 'Forbidden');
  assert.equal(viewer.readyState, WebSocket.OPEN);

  const statusAfterDenials = await sendCommand(viewer, COMMANDS.GET_STATUS);
  assert.equal(statusAfterDenials.ok, true);
  assert.equal(statusAfterDenials.result.videoRunning, true);
  assert.equal(await hlsStatus(viewerLogin.token), 200);
  assert.deepEqual(await commandStatuses(deniedStart.requestId), ['received', 'forbidden']);
  assert.deepEqual(await commandStatuses(deniedStop.requestId), ['received', 'forbidden']);

  await logout(viewer);
  assert.equal(await hlsStatus(viewerLogin.token), 401);
  console.log('[rbac-live] Viewer: video/GET_STATUS allowed, START/STOP forbidden without state change, socket remained usable, LOGOUT revoked HLS');

  const operatorLogin = await login('operator', 'operator123');
  assert.equal(operatorLogin.user.role, 'operator');
  const operator = await connect(operatorLogin.token);
  assert.equal((await sendCommand(operator, COMMANDS.GET_STATUS)).result.videoRunning, true);
  const beforeStopMtime = await segmentNewestMtime();
  const stopped = await sendCommand(operator, COMMANDS.STOP_VIDEO);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.result.videoRunning, false);
  assert.equal((await sendCommand(operator, COMMANDS.GET_STATUS)).result.videoRunning, false);
  assert.equal(await hlsStatus(operatorLogin.token), 503);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.ok(await segmentNewestMtime() > beforeStopMtime);
  const started = await sendCommand(operator, COMMANDS.START_VIDEO);
  assert.equal(started.ok, true);
  assert.equal(started.result.videoRunning, true);
  assert.equal((await sendCommand(operator, COMMANDS.GET_STATUS)).result.videoRunning, true);
  assert.equal(await hlsStatus(operatorLogin.token), 200);
  await logout(operator);
  assert.equal(await hlsStatus(operatorLogin.token), 401);
  console.log('[rbac-live] Operator: GET_STATUS/STOP/START allowed, delivery gate worked, segments advanced, LOGOUT revoked HLS');

  const adminLogin = await login('admin', 'admin123');
  assert.equal(adminLogin.user.role, 'operator');
  const admin = await connect(adminLogin.token);
  assert.equal((await sendCommand(admin, COMMANDS.STOP_VIDEO)).ok, true);
  assert.equal((await sendCommand(admin, COMMANDS.START_VIDEO)).ok, true);
  await logout(admin);
  assert.equal(await hlsStatus(adminLogin.token), 401);
  console.log('[rbac-live] Admin: existing operator role retained operator controls and LOGOUT');
  console.log('[rbac-live] Forbidden log example:', JSON.stringify({
    user: 'viewer',
    message: 'STOP_VIDEO',
    status: 'forbidden',
  }));
}

void main().catch((error) => {
  console.error(`[rbac-live] ${error.stack || error.message}`);
  process.exitCode = 1;
});
