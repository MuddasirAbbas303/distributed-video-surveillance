const http = require('node:http');
const express = require('express');
const config = require('./config');
const { createHlsRouter } = require('./hls-routes');
const { attachManagementSocket } = require('./management-socket');
const { createSessionRegistry } = require('./session-registry');
const { createTokenVerifier } = require('./token-verifier');
const { createVideoProcess, prepareHlsDirectory } = require('./video-process');
const videoState = require('./video-state');
let shuttingDown = false;
let server;
let managementSocket;

const videoProcess = createVideoProcess(config, () => void shutdown(1));
const sessionRegistry = createSessionRegistry();
const tokenVerifier = createTokenVerifier({
  jwtSecret: config.jwtSecret,
  sessionRegistry,
});

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[server-a] Shutting down...');

  await videoProcess.stop();
  if (managementSocket) await managementSocket.close();
  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  process.exitCode = exitCode;
}

function createApp() {
  const app = express();

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.use('/video', createHlsRouter({
    hlsDirectory: config.hlsDirectory,
    sessionRegistry,
    tokenVerifier,
    videoState,
    webOrigin: config.webOrigin,
  }));

  app.get('/test-player', (_request, response) => {
    response.type('html').send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HLS Test Player</title></head>
<body style="margin:2rem;background:#111;color:#eee;font-family:system-ui">
  <h1>Server A HLS Test Player</h1>
  <form id="player-form" style="display:flex;gap:.5rem;max-width:800px;margin-bottom:1rem">
    <input id="token" type="password" autocomplete="off" placeholder="Paste JWT" required style="flex:1;padding:.6rem">
    <button type="submit">Load authenticated stream</button>
  </form>
  <video id="video" controls autoplay muted playsinline style="width:min(100%,800px);background:#000"></video>
  <p id="status">Enter a JWT issued by Server B.</p>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
  <script>
    const form = document.getElementById('player-form');
    const tokenInput = document.getElementById('token');
    const video = document.getElementById('video');
    const status = document.getElementById('status');
    const source = '/video/stream.m3u8';
    let hls;

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const token = tokenInput.value.trim();
      if (!token) return;
      if (!window.Hls || !Hls.isSupported()) {
        status.textContent = 'This browser does not support hls.js playback';
        return;
      }
      if (hls) hls.destroy();
      hls = new Hls({
        liveSyncDurationCount: 2,
        xhrSetup(xhr) {
          xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        },
      });
      hls.loadSource(source);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        status.textContent = 'HLS manifest loaded';
        video.play().catch(() => { status.textContent = 'Press play to begin'; });
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) status.textContent = 'Playback error: ' + data.details;
      });
    });
  </script>
</body>
</html>`);
  });

  return app;
}

async function main() {
  await prepareHlsDirectory(config.hlsDirectory);
  server = http.createServer(createApp());
  managementSocket = attachManagementSocket(server, {
    secret: config.internalWsSecret,
    sessionRegistry,
    videoState,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });

  console.log(`[server-a] HTTP server listening on http://127.0.0.1:${config.port}`);
  await videoProcess.start();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('uncaughtException', (error) => {
  console.error(`[server-a] Fatal error: ${error.stack || error.message}`);
  void shutdown(1);
});
process.once('unhandledRejection', (error) => {
  console.error(`[server-a] Fatal rejection: ${error.stack || error}`);
  void shutdown(1);
});

void main().catch((error) => {
  console.error(`[server-a] Startup failed: ${error.stack || error.message}`);
  void shutdown(1);
});

module.exports = { createApp, prepareHlsDirectory };
