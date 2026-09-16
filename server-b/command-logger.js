const fs = require('node:fs/promises');
const {
  GENESIS_HASH,
  computeEntryHash,
  verifyCommandLogContent,
} = require('../shared/command-log-integrity');

class CommandLogWriteError extends Error {
  constructor(cause) {
    super('Command log append failed', { cause });
    this.name = 'CommandLogWriteError';
  }
}

function createCommandLogger(logFile, secret) {
  let writeChain = Promise.resolve();
  let initialized = false;
  let lastHash = GENESIS_HASH;
  let needsLineSeparator = false;

  async function initialize() {
    let contents = '';
    try {
      contents = await fs.readFile(logFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const verification = verifyCommandLogContent(contents, secret);
    lastHash = verification.lastHash;
    needsLineSeparator = contents.length > 0 && !contents.endsWith('\n');
    initialized = true;
    return verification;
  }

  function log({ user, message, requestId, status, error }) {
    writeChain = writeChain.then(async () => {
      if (!initialized) throw new Error('Command logger must be initialized before use');

      const entry = {
        timestamp: new Date().toISOString(),
        user: typeof user === 'string' ? user : 'unknown',
        message: typeof message === 'string' ? message : 'UNKNOWN_MESSAGE',
      };

      if (typeof requestId === 'string') entry.requestId = requestId.slice(0, 128);
      entry.status = typeof status === 'string' ? status : 'unknown';
      if (typeof error === 'string') entry.error = error.slice(0, 200);
      entry.previousHash = lastHash;
      entry.hash = computeEntryHash(entry, secret);

      const prefix = needsLineSeparator ? '\n' : '';
      try {
        await fs.appendFile(logFile, `${prefix}${JSON.stringify(entry)}\n`, 'utf8');
      } catch (writeError) {
        throw new CommandLogWriteError(writeError);
      }

      lastHash = entry.hash;
      needsLineSeparator = false;
      return entry;
    });

    return writeChain;
  }

  function flush() {
    return writeChain;
  }

  return { flush, initialize, log };
}

module.exports = { CommandLogWriteError, createCommandLogger };
