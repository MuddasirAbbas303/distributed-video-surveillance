const config = require('../server-b/config');
const { VideoServerSocket } = require('../server-b/video-server-socket');
const { COMMANDS } = require('../shared/protocol');

const defaultCommands = [
  COMMANDS.GET_STATUS,
  COMMANDS.STOP_VIDEO,
  COMMANDS.GET_STATUS,
  COMMANDS.START_VIDEO,
  COMMANDS.GET_STATUS,
];

async function main() {
  const commands = process.argv.slice(2);
  const commandsToRun = commands.length > 0 ? commands : defaultCommands;
  const client = new VideoServerSocket({
    controlUrl: config.serverAControlUrl,
    secret: config.internalWsSecret,
  });

  client.start();
  try {
    await client.waitForConnection();
    for (const command of commandsToRun) {
      try {
        const result = await client.sendCommand(command);
        console.log(JSON.stringify({ command, ok: true, result }));
      } catch (error) {
        console.log(JSON.stringify({ command, ok: false, error: error.message }));
      }
    }
  } finally {
    await client.stop();
  }
}

void main().catch((error) => {
  console.error(`[control-test] ${error.message}`);
  process.exitCode = 1;
});
