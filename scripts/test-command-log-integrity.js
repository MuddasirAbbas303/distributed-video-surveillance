const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCommandLogger } = require('../server-b/command-logger');
const {
  CommandLogIntegrityError,
  GENESIS_HASH,
  verifyCommandLogContent,
} = require('../shared/command-log-integrity');

const TEST_SECRET = 'command-log-integrity-test-secret-value';

function clone(entries) {
  return JSON.parse(JSON.stringify(entries));
}

function asNdjson(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function expectFailure(entries, expectedReason) {
  assert.throws(
    () => verifyCommandLogContent(asNdjson(entries), TEST_SECRET),
    (error) => error instanceof CommandLogIntegrityError
      && error.reason === expectedReason,
  );
}

async function main() {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'command-log-test-'));
  const logFile = path.join(temporaryDirectory, 'commands.log');

  try {
    const logger = createCommandLogger(logFile, TEST_SECRET);
    assert.deepEqual(await logger.initialize(), { count: 0, lastHash: GENESIS_HASH });

    await Promise.all(Array.from({ length: 40 }, (_, index) => logger.log({
      user: index % 2 === 0 ? 'operator' : 'viewer',
      message: 'GET_STATUS',
      requestId: `concurrent-${index}`,
      status: 'received',
    })));
    await logger.flush();

    const validContents = await fs.readFile(logFile, 'utf8');
    const validResult = verifyCommandLogContent(validContents, TEST_SECRET);
    assert.equal(validResult.count, 40);
    const entries = validContents.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(entries[0].previousHash, GENESIS_HASH);
    for (let index = 1; index < entries.length; index += 1) {
      assert.equal(entries[index].previousHash, entries[index - 1].hash);
    }
    console.log('[command-log-test] Concurrent serialized writes: Integrity OK');

    const modified = clone(entries);
    modified[10].message = 'STOP_VIDEO';
    expectFailure(modified, 'HMAC mismatch');
    console.log('[command-log-test] Modified entry: detected');

    const deleted = clone(entries);
    deleted.splice(10, 1);
    expectFailure(deleted, 'previousHash chain mismatch');
    console.log('[command-log-test] Deleted middle entry: detected');

    const reordered = clone(entries);
    [reordered[10], reordered[11]] = [reordered[11], reordered[10]];
    expectFailure(reordered, 'previousHash chain mismatch');
    console.log('[command-log-test] Reordered entries: detected');

    const changedHash = clone(entries);
    changedHash[10].hash = `${changedHash[10].hash.slice(0, -1)}${changedHash[10].hash.endsWith('0') ? '1' : '0'}`;
    expectFailure(changedHash, 'HMAC mismatch');
    console.log('[command-log-test] Modified stored hash: detected');

    const restartLogger = createCommandLogger(logFile, TEST_SECRET);
    const restartState = await restartLogger.initialize();
    assert.equal(restartState.lastHash, validResult.lastHash);
    const appended = await restartLogger.log({
      user: 'operator',
      message: 'GET_STATUS',
      requestId: 'after-restart',
      status: 'received',
    });
    assert.equal(appended.previousHash, validResult.lastHash);
    assert.equal(verifyCommandLogContent(await fs.readFile(logFile, 'utf8'), TEST_SECRET).count, 41);
    console.log('[command-log-test] Restart chain continuation: Integrity OK');

    const corruptedFile = path.join(temporaryDirectory, 'corrupted.log');
    await fs.writeFile(corruptedFile, asNdjson(modified), 'utf8');
    const sizeBefore = (await fs.stat(corruptedFile)).size;
    const corruptedLogger = createCommandLogger(corruptedFile, TEST_SECRET);
    await assert.rejects(
      corruptedLogger.initialize(),
      /Command log integrity verification failed/,
    );
    assert.equal((await fs.stat(corruptedFile)).size, sizeBefore);
    console.log('[command-log-test] Corrupted startup: refused without append');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(`[command-log-test] ${error.stack || error.message}`);
  process.exitCode = 1;
});
