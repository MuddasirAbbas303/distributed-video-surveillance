const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const config = require('../server-b/config');
const { COMMANDS } = require('../shared/protocol');
const { connect, login, sendCommand } = require('./test-client-websocket');

const projectRoot = path.resolve(__dirname, '..');
const hlsUrl = 'http://127.0.0.1:3001/video/stream.m3u8';
const services = new Set();
const results = [];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function record(name, detail) {
  results.push({ name, detail });
  console.log(`[step7-live] PASS ${name}: ${detail}`);
}

function startService(name, entryPoint) {
  const child = spawn(process.execPath, [entryPoint], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const service = { child, name, output: '' };
  services.add(service);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      service.output += chunk.toString();
      if (service.output.length > 100_000) service.output = service.output.slice(-100_000);
    });
  }
  return service;
}

async function stopService(service) {
  if (!service || !services.has(service)) return;
  services.delete(service);
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      service.child.kill('SIGKILL');
    }, 5000);
    service.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    service.child.kill('SIGTERM');
  });
}

async function stopAllServices() {
  await Promise.all([...services].map(stopService));
}

async function waitUntil(action, predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastValue = await action();
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  const detail = lastError?.message || JSON.stringify(lastValue);
  throw new Error(`Timed out waiting for ${description}; last result: ${detail}`);
}

async function waitForHealth(port) {
  await waitUntil(
    () => fetch(`http://127.0.0.1:${port}/health`),
    (response) => response.status === 200,
    `health on port ${port}`,
  );
}

async function hlsRequest(token, resource = hlsUrl) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetch(resource, { headers, cache: 'no-store' });
  return {
    body: await response.text(),
    cacheControl: response.headers.get('cache-control'),
    contentType: response.headers.get('content-type'),
    status: response.status,
  };
}

async function waitForHlsStatus(token, expectedStatus, description) {
  return waitUntil(
    () => hlsRequest(token),
    (result) => result.status === expectedStatus,
    description,
  );
}

function corruptSignature(token) {
  const pieces = token.split('.');
  const firstCharacter = pieces[2][0];
  pieces[2] = `${firstCharacter === 'A' ? 'B' : 'A'}${pieces[2].slice(1)}`;
  return pieces.join('.');
}

async function logout(token) {
  const webSocket = await connect(token);
  const response = await sendCommand(webSocket, COMMANDS.LOGOUT);
  assert.equal(response.ok, true);
  await new Promise((resolve) => {
    if (webSocket.readyState === 3) resolve();
    else webSocket.once('close', resolve);
  });
}

async function sendVideoCommand(token, command) {
  const webSocket = await connect(token);
  try {
    return await sendCommand(webSocket, command);
  } finally {
    webSocket.close();
  }
}

async function getSegmentState() {
  const names = (await fs.readdir(configPath('runtime/hls')))
    .filter((name) => name.endsWith('.ts'));
  const records = await Promise.all(names.map(async (name) => {
    const stats = await fs.stat(configPath(`runtime/hls/${name}`));
    return { name, modifiedAt: stats.mtimeMs, size: stats.size };
  }));
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

function configPath(relativePath) {
  return path.join(projectRoot, relativePath);
}

function hlsFfmpegPid(serverA) {
  const matches = [...serverA.output.matchAll(/HLS FFmpeg started \(PID (\d+)\)/g)];
  assert.ok(matches.length > 0, 'Server A did not report its FFmpeg PID');
  return Number(matches.at(-1)[1]);
}

async function assertProcessAlive(pid) {
  process.kill(pid, 0);
}

async function main() {
  let camera;
  let serverA;
  let serverB;

  try {
    camera = startService('camera', 'camera/camera-simulator.js');
    await waitUntil(
      async () => camera.output,
      (output) => output.includes('RTSP stream available'),
      'camera RTSP publication',
    );

    serverA = startService('server-a', 'server-a/index.js');
    await waitForHealth(3001);
    const initial = await hlsRequest();
    assert.equal(initial.status, 503);
    assert.equal(initial.body, 'Authorization state unavailable');
    assert.equal(initial.cacheControl, 'no-store');
    record('initial fail-closed state', 'HTTP 503 Authorization state unavailable');

    serverB = startService('server-b', 'server-b/index.js');
    await waitForHealth(3002);
    await waitForHlsStatus(null, 401, 'initial empty session synchronization');
    assert.match(serverA.output, /Session synchronization completed: 0 active sessions/);
    assert.match(serverB.output, /Session synchronization acknowledged: 0 active sessions/);
    record('SESSION_SYNC', 'empty startup snapshot acknowledged');

    const first = await login();
    const firstPlaylist = await waitForHlsStatus(first.token, 200, 'first activated session HLS');
    assert.match(firstPlaylist.body, /^#EXTM3U/m);
    assert.equal(firstPlaylist.cacheControl, 'no-store');
    record('SESSION_ACTIVATE and valid playlist', 'HTTP 200 with no-store');

    assert.equal((await hlsRequest()).status, 401);
    record('no token', 'HTTP 401');

    const decoded = jwt.decode(first.token);
    const invalidTokens = [
      'malformed-token',
      corruptSignature(first.token),
      jwt.sign(
        { role: decoded.role, jti: decoded.jti },
        config.jwtSecret,
        { algorithm: 'HS256', expiresIn: -1, subject: decoded.sub },
      ),
      jwt.sign(
        { role: decoded.role, jti: 'unknown-session' },
        config.jwtSecret,
        { algorithm: 'HS256', expiresIn: 60, subject: decoded.sub },
      ),
      jwt.sign(
        { role: 'mismatched-role', jti: decoded.jti },
        config.jwtSecret,
        { algorithm: 'HS256', expiresIn: 60, subject: decoded.sub },
      ),
    ];
    for (const token of invalidTokens) assert.equal((await hlsRequest(token)).status, 401);
    record('invalid tokens', 'malformed, bad signature, expired, unknown jti, and claim mismatch all HTTP 401');

    const segmentName = firstPlaylist.body.split(/\r?\n/).find((line) => line.endsWith('.ts'));
    assert.ok(segmentName);
    const segmentUrl = new URL(segmentName, hlsUrl).toString();
    assert.equal((await hlsRequest(null, segmentUrl)).status, 401);
    const authorizedSegment = await hlsRequest(first.token, segmentUrl);
    assert.equal(authorizedSegment.status, 200);
    assert.match(authorizedSegment.contentType, /^video\/mp2t/);
    record('segment authorization', 'without token HTTP 401; with active token HTTP 200');

    await logout(first.token);
    assert.equal((await hlsRequest(first.token)).status, 401);
    const protectedAfterLogout = await fetch('http://127.0.0.1:3002/protected', {
      headers: { authorization: `Bearer ${first.token}` },
    });
    assert.equal(protectedAfterLogout.status, 401);
    record('SESSION_REVOKE', 'same JWT immediately returns HLS 401 and /protected 401');

    const sessionA = await login();
    const sessionB = await login();
    assert.equal((await hlsRequest(sessionA.token)).status, 200);
    assert.equal((await hlsRequest(sessionB.token)).status, 200);
    await logout(sessionA.token);
    assert.equal((await hlsRequest(sessionA.token)).status, 401);
    assert.equal((await hlsRequest(sessionB.token)).status, 200);
    record('two same-user sessions', 'logged-out token HTTP 401; independent token HTTP 200');

    const ffmpegPidBeforeStop = hlsFfmpegPid(serverA);
    const segmentsBeforeStop = await getSegmentState();
    const stopResponse = await sendVideoCommand(sessionB.token, COMMANDS.STOP_VIDEO);
    assert.equal(stopResponse.ok, true);
    assert.equal(stopResponse.result.videoRunning, false);
    const stopped = await hlsRequest(sessionB.token);
    assert.equal(stopped.status, 503);
    assert.equal(stopped.body, 'Video delivery is stopped');
    const stillProtected = await fetch('http://127.0.0.1:3002/protected', {
      headers: { authorization: `Bearer ${sessionB.token}` },
    });
    assert.equal(stillProtected.status, 200);
    await delay(2500);
    await assertProcessAlive(ffmpegPidBeforeStop);
    assert.equal(hlsFfmpegPid(serverA), ffmpegPidBeforeStop);
    const segmentsAfterStop = await getSegmentState();
    const newestBefore = Math.max(...segmentsBeforeStop.map(({ modifiedAt }) => modifiedAt));
    const newestAfter = Math.max(...segmentsAfterStop.map(({ modifiedAt }) => modifiedAt));
    assert.ok(newestAfter > newestBefore);
    const startResponse = await sendVideoCommand(sessionB.token, COMMANDS.START_VIDEO);
    assert.equal(startResponse.ok, true);
    assert.equal((await waitForHlsStatus(sessionB.token, 200, 'HLS after START_VIDEO')).status, 200);
    record('STOP_VIDEO delivery gate', 'HLS 503 while JWT stays valid, FFmpeg PID stays alive, and segments advance; START_VIDEO restores HTTP 200');

    await stopService(serverA);
    await delay(700);
    serverA = startService('server-a', 'server-a/index.js');
    await waitForHealth(3001);
    const beforeRestartSync = await hlsRequest(sessionB.token);
    assert.equal(beforeRestartSync.status, 503);
    assert.equal(beforeRestartSync.body, 'Authorization state unavailable');
    await waitForHlsStatus(sessionB.token, 200, 'Server A restart session recovery');
    record('Server A restart', 'HTTP 503 before sync, then existing token HTTP 200 after SESSION_SYNC');

    await stopService(serverA);
    const loggedInOffline = await login();
    record('login while Server A offline', 'Server B issued a JWT without failing login');
    await delay(700);
    serverA = startService('server-a', 'server-a/index.js');
    await waitForHealth(3001);
    await waitForHlsStatus(loggedInOffline.token, 200, 'offline-login snapshot recovery');
    record('offline login recovery', 'new session arrived in full snapshot and HLS returned 200');

    const offlineLogoutSocket = await connect(loggedInOffline.token);
    await stopService(serverA);
    const offlineLogoutResponse = await sendCommand(offlineLogoutSocket, COMMANDS.LOGOUT);
    assert.equal(offlineLogoutResponse.ok, true);
    await delay(700);
    serverA = startService('server-a', 'server-a/index.js');
    await waitForHealth(3001);
    await waitForHlsStatus(loggedInOffline.token, 401, 'offline logout exclusion from snapshot');
    record('logout while Server A offline', 'revoked session was absent from fresh snapshot and old JWT returned 401');

    const beforeServerBRestart = await login();
    await waitForHlsStatus(beforeServerBRestart.token, 200, 'pre Server B restart HLS');
    await stopService(serverB);
    const disconnected = await waitForHlsStatus(
      beforeServerBRestart.token,
      503,
      'fail-closed after trusted control disconnect',
    );
    assert.equal(disconnected.body, 'Authorization state unavailable');
    record('trusted control disconnect', 'Server A immediately failed closed with HTTP 503');

    serverB = startService('server-b', 'server-b/index.js');
    await waitForHealth(3002);
    await waitForHlsStatus(beforeServerBRestart.token, 401, 'stale session removal after Server B restart');
    record('Server B restart', 'empty in-memory snapshot replaced stale registry; old JWT HTTP 401');

    const testPlayer = await fetch('http://127.0.0.1:3001/test-player').then((response) => response.text());
    assert.match(testPlayer, /xhrSetup/);
    assert.match(testPlayer, /Authorization/);
    assert.doesNotMatch(testPlayer, /canPlayType/);
    record('temporary hls.js test page', 'Bearer header configured for all hls.js requests; native HLS path absent');

    const sourceFiles = await Promise.all([
      fs.readFile(configPath('server-a/hls-routes.js'), 'utf8'),
      fs.readFile(configPath('server-a/token-verifier.js'), 'utf8'),
    ]);
    assert.doesNotMatch(sourceFiles.join('\n'), /127\.0\.0\.1:3002|\/protected|\/auth\//);
    record('local authorization', 'Server A HLS authorization has no Server B REST dependency');

    const commandLog = await fs.readFile(config.commandLogFile, 'utf8').catch(() => '');
    const combinedLogs = [camera.output, serverA.output, serverB.output, commandLog].join('\n');
    assert.doesNotMatch(combinedLogs, /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    assert.equal(combinedLogs.includes(config.jwtSecret), false);
    assert.equal(combinedLogs.includes(config.internalWsSecret), false);
    assert.equal(combinedLogs.includes(config.logHmacSecret), false);
    record('secret-safe logs', 'no JWT or configured secret appeared in captured service/command logs');

    console.log(`[step7-live] ${results.length} live validation groups passed`);
  } finally {
    await stopAllServices();
  }
}

void main().catch((error) => {
  console.error(`[step7-live] FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
});
