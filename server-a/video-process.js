const path = require('node:path');
const fs = require('node:fs/promises');
const { ProcessSupervisor } = require('../camera/process-supervisor');

const GENERATED_HLS_FILE = /\.(m3u8|ts|m4s)$/i;

async function prepareHlsDirectory(hlsDirectory) {
  await fs.mkdir(hlsDirectory, { recursive: true });
  const entries = await fs.readdir(hlsDirectory, { withFileTypes: true });

  await Promise.all(entries
    .filter((entry) => entry.isFile() && GENERATED_HLS_FILE.test(entry.name))
    .map((entry) => fs.unlink(path.join(hlsDirectory, entry.name))));
}

function createHlsArguments({ hlsDirectory, rtspUrl }) {
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-map', '0:v:0',
    '-an',
    '-c:v', 'copy',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '6',
    '-hls_delete_threshold', '2',
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
    '-hls_segment_filename', path.join(hlsDirectory, 'segment-%06d.ts'),
    path.join(hlsDirectory, 'stream.m3u8'),
  ];
}

function createVideoProcess(config, onFatal) {
  return new ProcessSupervisor({
    name: 'HLS FFmpeg',
    command: config.ffmpegPath,
    getArguments: () => createHlsArguments(config),
    beforeStart: () => prepareHlsDirectory(config.hlsDirectory),
    spawnOptions: { stdio: ['ignore', 'inherit', 'pipe'] },
    logPrefix: 'server-a',
    onFatal,
    onOutput(child) {
      child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    },
  });
}

module.exports = { createHlsArguments, createVideoProcess, prepareHlsDirectory };
