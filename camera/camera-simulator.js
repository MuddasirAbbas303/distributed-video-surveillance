const net = require('node:net');
const path = require('node:path');
const dotenv = require('dotenv');
const { ProcessSupervisor } = require('./process-supervisor');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const mediaMtxPath = process.env.MEDIAMTX_PATH || 'mediamtx';
const rtspUrl = process.env.RTSP_URL || 'rtsp://127.0.0.1:1111/camera';
const fontFile = process.env.FFMPEG_FONT_FILE || '';
const mediaMtxConfig = path.resolve(__dirname, 'mediamtx.yml');

let parsedRtspUrl;
try {
  parsedRtspUrl = new URL(rtspUrl);
} catch {
  console.error(`[camera] Fatal: RTSP_URL is not a valid URL: ${rtspUrl}`);
  process.exitCode = 1;
  return;
}

if (parsedRtspUrl.protocol !== 'rtsp:') {
  console.error(`[camera] Fatal: RTSP_URL must use the rtsp:// protocol: ${rtspUrl}`);
  process.exitCode = 1;
  return;
}

const rtspHost = parsedRtspUrl.hostname;
const rtspPort = Number(parsedRtspUrl.port || 554);
let shuttingDown = false;

function waitForPort(host, port, timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tryConnection = () => {
      if (shuttingDown) {
        reject(new Error('camera is shutting down'));
        return;
      }

      const socket = net.createConnection({ host, port });
      socket.setTimeout(1000);
      let attemptFinished = false;

      socket.once('connect', () => {
        if (attemptFinished) return;
        attemptFinished = true;
        socket.destroy();
        resolve();
      });

      const retry = () => {
        if (attemptFinished) return;
        attemptFinished = true;
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(tryConnection, 250);
      };

      socket.once('error', retry);
      socket.once('timeout', retry);
    };

    tryConnection();
  });
}

function escapeFilterValue(value) {
  return value
    .replaceAll('\\', '/')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'");
}

function createVideoFilter() {
  if (!fontFile) return null;

  const fontOption = `fontfile='${escapeFilterValue(path.resolve(fontFile))}':`;

  return [
    'drawtext=',
    fontOption,
    "text='Elapsed %{pts\\:hms}':",
    'fontcolor=white:',
    'fontsize=32:',
    'box=1:',
    'boxcolor=black@0.65:',
    'boxborderw=10:',
    'x=20:',
    'y=h-th-20',
  ].join('');
}

function createFfmpegArguments() {
  const argumentsList = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-re',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=640x480:rate=30',
  ];

  const videoFilter = createVideoFilter();
  if (videoFilter) {
    argumentsList.push('-vf', videoFilter);
  }

  argumentsList.push(
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-level:v', '3.1',
    '-pix_fmt', 'yuv420p',
    '-g', '30',
    '-keyint_min', '30',
    '-sc_threshold', '0',
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    rtspUrl,
  );

  return argumentsList;
}

function observeFfmpegOutput(child) {
  let recentErrors = '';

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    recentErrors = `${recentErrors}${text}`.slice(-8000);
  });

  child.once('exit', (code) => {
    if (code !== 0 && /No such filter:\s*'drawtext'/i.test(recentErrors)) {
      console.error('[camera] This FFmpeg build does not include the optional drawtext filter.');
      console.error('[camera] Clear FFMPEG_FONT_FILE to use testsrc2\'s built-in elapsed timestamp.');
    } else if (code !== 0 && /drawtext|font|freetype/i.test(recentErrors)) {
      console.error('[camera] FFmpeg could not render the timestamp text.');
      console.error('[camera] Set FFMPEG_FONT_FILE to a valid TrueType or OpenType font path in .env.');
    }
  });
}

async function reportMediaMtxReady() {
  await waitForPort(rtspHost, rtspPort);
  console.log(`[camera] MediaMTX ready on ${rtspHost}:${rtspPort}`);
}

const mediaMtx = new ProcessSupervisor({
  name: 'MediaMTX',
  command: mediaMtxPath,
  getArguments: () => [mediaMtxConfig],
  spawnOptions: { stdio: ['ignore', 'inherit', 'inherit'] },
  onFatal: () => void shutdown(1),
});

const ffmpeg = new ProcessSupervisor({
  name: 'FFmpeg',
  command: ffmpegPath,
  getArguments: createFfmpegArguments,
  beforeStart: reportMediaMtxReady,
  spawnOptions: { stdio: ['ignore', 'inherit', 'pipe'] },
  onOutput: observeFfmpegOutput,
  onFatal: () => void shutdown(1),
});

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[camera] Shutting down...');
  await Promise.all([ffmpeg.stop(), mediaMtx.stop()]);
  process.exitCode = exitCode;
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

process.once('uncaughtException', (error) => {
  console.error(`[camera] Fatal error: ${error.stack || error.message}`);
  void shutdown(1);
});

process.once('unhandledRejection', (error) => {
  console.error(`[camera] Fatal rejection: ${error.stack || error}`);
  void shutdown(1);
});

async function main() {
  console.log('[camera] Distributed Video Surveillance camera simulator');
  await mediaMtx.start();
  await ffmpeg.start();
  console.log('[camera] RTSP stream available:');
  console.log(`[camera] ${rtspUrl}`);
}

void main().catch((error) => {
  console.error(`[camera] Startup failed: ${error.message}`);
  void shutdown(1);
});

module.exports = { createFfmpegArguments, createVideoFilter, waitForPort };
