const path = require('node:path');
const dotenv = require('dotenv');

const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

function readPort(value, fallback) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SERVER_B_PORT must be an integer between 1 and 65535; received ${value}`);
  }
  return port;
}

const nodeEnvironment = process.env.NODE_ENV || 'development';
const jwtSecret = process.env.JWT_SECRET;
const internalWsSecret = process.env.INTERNAL_WS_SECRET;
const logHmacSecret = process.env.LOG_HMAC_SECRET;
const insecureSecrets = new Set(['change-me', 'secret', 'development-secret']);

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required. Set it in the local .env file.');
}

if (!internalWsSecret) {
  throw new Error('INTERNAL_WS_SECRET is required. Set it in the local .env file.');
}

if (!logHmacSecret) {
  throw new Error('LOG_HMAC_SECRET is required. Set it in the local .env file.');
}

if (!['development', 'test'].includes(nodeEnvironment) && insecureSecrets.has(jwtSecret)) {
  throw new Error('JWT_SECRET is insecure. Configure a strong secret before starting Server B.');
}


if (!['development', 'test'].includes(nodeEnvironment) && insecureSecrets.has(internalWsSecret)) {
  throw new Error('INTERNAL_WS_SECRET is insecure. Configure a strong secret before starting Server B.');
}

if (!['development', 'test'].includes(nodeEnvironment)
  && (insecureSecrets.has(logHmacSecret) || logHmacSecret.length < 32)) {
  throw new Error('LOG_HMAC_SECRET is insecure. Configure at least 32 characters before starting Server B.');
}

const serverAControlUrl = process.env.SERVER_A_CONTROL_URL || 'ws://127.0.0.1:3001/internal/control';
if (!/^wss?:$/.test(new URL(serverAControlUrl).protocol)) {
  throw new Error('SERVER_A_CONTROL_URL must use ws:// or wss://');
}

module.exports = {
  commandLogFile: path.join(projectRoot, 'commands.log'),
  hlsClientFile: path.join(projectRoot, 'node_modules', 'hls.js', 'dist', 'hls.min.js'),
  jwtExpiresInSeconds: 3600,
  jwtSecret,
  internalWsSecret,
  logHmacSecret,
  nodeEnvironment,
  port: readPort(process.env.SERVER_B_PORT, 3002),
  publicDirectory: path.join(projectRoot, 'public'),
  serverAControlUrl,
  usersFile: path.join(__dirname, 'users.json'),
};
