const fs = require('node:fs/promises');
const path = require('node:path');
const dotenv = require('dotenv');
const {
  CommandLogIntegrityError,
  verifyCommandLogContent,
} = require('../shared/command-log-integrity');

const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

async function main() {
  const secret = process.env.LOG_HMAC_SECRET;
  if (!secret) throw new Error('LOG_HMAC_SECRET is required');

  const requestedPath = process.argv[2];
  const logFile = requestedPath
    ? path.resolve(process.cwd(), requestedPath)
    : path.join(projectRoot, 'commands.log');
  const contents = await fs.readFile(logFile, 'utf8');
  const result = verifyCommandLogContent(contents, secret);
  console.log(`Verified ${result.count} command log entries.`);
  console.log('Integrity: OK');
}

void main().catch((error) => {
  console.error('Integrity: FAILED');
  if (error instanceof CommandLogIntegrityError) {
    console.error(`Entry: ${error.entry}`);
    console.error(`Reason: ${error.reason}`);
  } else {
    console.error(`Reason: ${error.code === 'ENOENT' ? 'command log not found' : error.message}`);
  }
  process.exitCode = 1;
});
