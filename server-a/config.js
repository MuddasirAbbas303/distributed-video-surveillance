const path = require('node:path');
const dotenv = require('dotenv');

const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

function readPort(value, fallback) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SERVER_A_PORT must be an integer between 1 and 65535; received ${value}`);
  }
  return port;
}

function readWebOrigin(value) {
  const configuredValue = value || 'http://127.0.0.1:3002';
  let origin;
  try {
    origin = new URL(configuredValue);
  } catch {
    throw new Error('WEB_ORIGIN must be a valid HTTP or HTTPS origin');
  }
  if (!['http:', 'https:'].includes(origin.protocol)
    || origin.username
    || origin.password
    || origin.pathname !== '/'
    || origin.search
    || origin.hash) {
    throw new Error('WEB_ORIGIN must be an HTTP or HTTPS origin without a path');
  }
  return origin.origin;
}

const nodeEnvironment = process.env.NODE_ENV || 'development';
const jwtSecret = process.env.JWT_SECRET;
const internalWsSecret = process.env.INTERNAL_WS_SECRET;
const insecureSecrets = new Set(['change-me', 'secret', 'development-secret']);
if (!jwtSecret) {
  throw new Error('JWT_SECRET is required. Set it in the local .env file.');
}
if (!internalWsSecret) {
  throw new Error('INTERNAL_WS_SECRET is required. Set it in the local .env file.');
}
if (!['development', 'test'].includes(nodeEnvironment) && insecureSecrets.has(jwtSecret)) {
  throw new Error('JWT_SECRET is insecure. Configure a strong secret before starting Server A.');
}
if (!['development', 'test'].includes(nodeEnvironment) && insecureSecrets.has(internalWsSecret)) {
  throw new Error('INTERNAL_WS_SECRET is insecure. Configure a strong secret before starting Server A.');
}

module.exports = {
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  hlsDirectory: path.join(projectRoot, 'runtime', 'hls'),
  internalWsSecret,
  jwtSecret,
  nodeEnvironment,
  port: readPort(process.env.SERVER_A_PORT, 3001),
  rtspUrl: process.env.RTSP_URL || 'rtsp://127.0.0.1:1111/camera',
  webOrigin: readWebOrigin(process.env.WEB_ORIGIN),
};
