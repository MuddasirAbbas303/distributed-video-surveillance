const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');

function runVerifier(logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/verify-command-log.js', logFile], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => { output += chunk.toString(); });
    }
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}

async function assertVerifierRejects(directory, name, entries) {
  const file = path.join(directory, `${name}.log`);
  await fs.writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  const result = await runVerifier(file);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Integrity: FAILED/);
  return result.output;
}

function clone(entries) {
  return JSON.parse(JSON.stringify(entries));
}

async function main() {
  const contents = await fs.readFile(path.join(projectRoot, 'commands.log'), 'utf8');
  const entries = contents.trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(entries.length >= 4, 'At least four valid records are required');
  const middle = Math.floor(entries.length / 2);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'command-log-tamper-'));

  try {
    const modified = clone(entries);
    modified[middle].message = modified[middle].message === 'GET_STATUS'
      ? 'STOP_VIDEO'
      : 'GET_STATUS';
    assert.match(await assertVerifierRejects(temporaryDirectory, 'modified-entry', modified), /HMAC mismatch/);
    console.log('[command-log-tamper] Modified message: verifier failed as expected');

    const deleted = clone(entries);
    deleted.splice(middle, 1);
    assert.match(await assertVerifierRejects(temporaryDirectory, 'deleted-entry', deleted), /previousHash chain mismatch/);
    console.log('[command-log-tamper] Deleted middle entry: verifier failed as expected');

    const reordered = clone(entries);
    [reordered[middle], reordered[middle + 1]] = [reordered[middle + 1], reordered[middle]];
    assert.match(await assertVerifierRejects(temporaryDirectory, 'reordered-entries', reordered), /previousHash chain mismatch/);
    console.log('[command-log-tamper] Reordered entries: verifier failed as expected');

    const changedHash = clone(entries);
    changedHash[middle].hash = `${changedHash[middle].hash.slice(0, -1)}${changedHash[middle].hash.endsWith('0') ? '1' : '0'}`;
    assert.match(await assertVerifierRejects(temporaryDirectory, 'modified-hash', changedHash), /HMAC mismatch/);
    console.log('[command-log-tamper] Modified stored hash: verifier failed as expected');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(`[command-log-tamper] ${error.stack || error.message}`);
  process.exitCode = 1;
});
