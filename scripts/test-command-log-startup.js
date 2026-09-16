const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');
const { verifyCommandLogContent } = require('../shared/command-log-integrity');

const projectRoot = path.resolve(__dirname, '..');
const logFile = path.join(projectRoot, 'commands.log');
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

function runCorruptedServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server-b/index.js'], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Corrupted Server B startup did not terminate'));
    }, 5000);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => { output += chunk.toString(); });
    }
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}

async function main() {
  const secret = process.env.LOG_HMAC_SECRET;
  if (!secret) throw new Error('LOG_HMAC_SECRET is required');

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'command-log-startup-'));
  const backupFile = path.join(temporaryDirectory, 'commands.valid.log');
  await fs.copyFile(logFile, backupFile);

  try {
    const validContents = await fs.readFile(backupFile, 'utf8');
    verifyCommandLogContent(validContents, secret);
    const entries = validContents.trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(entries.length > 0, 'A non-empty valid runtime log is required');
    entries[Math.floor(entries.length / 2)].message = 'CONTROLLED_TAMPER';
    const corruptedContents = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    await fs.writeFile(logFile, corruptedContents, 'utf8');

    const result = await runCorruptedServer();
    assert.equal(result.code, 1);
    assert.match(result.output, /Command log integrity verification failed/);
    assert.equal(await fs.readFile(logFile, 'utf8'), corruptedContents);
    console.log('[command-log-startup] Corrupted chain prevented Server B startup and no record was appended');
  } finally {
    await fs.copyFile(backupFile, logFile);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }

  verifyCommandLogContent(await fs.readFile(logFile, 'utf8'), secret);
  console.log('[command-log-startup] Original valid command log restored and verified');
}

void main().catch((error) => {
  console.error(`[command-log-startup] ${error.stack || error.message}`);
  process.exitCode = 1;
});
