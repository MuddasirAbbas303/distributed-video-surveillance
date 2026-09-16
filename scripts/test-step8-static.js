const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
const app = read('public/app.js');
const index = read('public/index.html');
const docs = read('public/docs.html');
const commandLogIntegrity = read('shared/command-log-integrity.js');
const commandLogger = read('server-b/command-logger.js');
const permissions = read('shared/permissions.js');
const packageJson = JSON.parse(read('package.json'));
const users = JSON.parse(read('server-b/users.json'));

assert.match(index, /id="login-form"/);
assert.match(index, /type="password"/);
assert.match(index, /id="video"/);
assert.match(index, /id="command-input"/);
assert.match(index, /id="console-output"/);
assert.match(index, /\/vendor\/hls\.min\.js/);

for (const command of ['START_VIDEO', 'STOP_VIDEO', 'GET_STATUS', 'LOGOUT']) {
  assert.ok(app.includes(command));
}
assert.match(app, /xhr\.setRequestHeader\('Authorization'/);
assert.match(app, /crypto\?\.randomUUID/);
assert.match(app, /pendingRequests: new Map/);
assert.match(app, /\/ws/);
assert.doesNotMatch(app, /localStorage|sessionStorage|innerHTML/);
assert.doesNotMatch(app, /video\/stream\.m3u8\?[^'"`\s]*/);
assert.match(app, /Viewer permissions: video, GET_STATUS, and LOGOUT/);
assert.match(permissions, /function canExecuteCommand/);
assert.match(docs, /Bonus A: role-based access control/);
assert.match(docs, /HMAC command-log integrity/);
assert.match(commandLogIntegrity, /createHmac\('sha256'/);
assert.match(commandLogIntegrity, /timingSafeEqual/);
assert.match(commandLogger, /verifyCommandLogContent/);
assert.equal(packageJson.scripts['verify:command-log'], 'node scripts/verify-command-log.js');

for (const section of [
  'Architecture',
  'Component interaction diagram',
  'Technologies used',
  'Setup instructions',
  'Architectural decisions',
  'Specification ambiguities',
  'Limitations',
]) {
  assert.ok(docs.toLowerCase().includes(section.toLowerCase()), `Missing docs section: ${section}`);
}

assert.ok(packageJson.dependencies['hls.js']);
assert.equal(users.length, 3);
for (const user of users) {
  assert.match(user.passwordHash, /^\$2[aby]\$/);
  assert.equal(Object.hasOwn(user, 'password'), false);
}

const runtimeFiles = [
  ...fs.readdirSync(path.join(projectRoot, 'camera')).filter((file) => file.endsWith('.js')).map((file) => `camera/${file}`),
  ...fs.readdirSync(path.join(projectRoot, 'server-a')).filter((file) => file.endsWith('.js')).map((file) => `server-a/${file}`),
  ...fs.readdirSync(path.join(projectRoot, 'server-b')).filter((file) => file.endsWith('.js')).map((file) => `server-b/${file}`),
  ...fs.readdirSync(path.join(projectRoot, 'shared')).filter((file) => file.endsWith('.js')).map((file) => `shared/${file}`),
];
const runtimeSource = runtimeFiles.map(read).join('\n');
assert.doesNotMatch(runtimeSource, /\/opt\/homebrew|ffmpeg\.exe|mediamtx\.exe|shell\s*:\s*true/);
assert.doesNotMatch(runtimeSource, /child_process\.(exec|execSync)|require\(['"]node:child_process['"]\)\.exec/);

console.log('[step8-static] Web client, documentation, credential, and portability checks passed');
