import { spawn } from 'node:child_process';
import net from 'node:net';

const inputPort = Number.parseInt(process.env.CHATIRL_CAPTURE_PORT ?? '49152', 10);
const obsPort = Number.parseInt(process.env.CHATIRL_OBS_UDP_PORT ?? '49153', 10);
const ffmpegBinary = process.env.FFMPEG_BIN?.trim() || 'ffmpeg';

if (!Number.isInteger(inputPort) || inputPort < 1 || inputPort > 65535) {
  throw new Error('CHATIRL_CAPTURE_PORT must be a valid TCP port.');
}
if (!Number.isInteger(obsPort) || obsPort < 1 || obsPort > 65535) {
  throw new Error('CHATIRL_OBS_UDP_PORT must be a valid UDP port.');
}

let activeSocket = null;
let activeFfmpeg = null;
let byteCount = 0;
let lastByteCount = 0;
let connectedAt = 0;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function stopPipeline(reason) {
  if (activeSocket != null) {
    activeSocket.destroy();
    activeSocket = null;
  }
  if (activeFfmpeg != null) {
    activeFfmpeg.stdin.end();
    activeFfmpeg.kill('SIGTERM');
    activeFfmpeg = null;
  }
  if (reason) log(reason);
}

function startPipeline(socket) {
  stopPipeline(activeSocket == null ? '' : 'Replaced the previous Quest connection.');
  activeSocket = socket;
  byteCount = 0;
  lastByteCount = 0;
  connectedAt = Date.now();
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 2000);

  const udpUrl = `udp://127.0.0.1:${obsPort}?pkt_size=1316`;
  const ffmpeg = spawn(
    ffmpegBinary,
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-fflags',
      '+genpts+nobuffer',
      '-flags',
      'low_delay',
      '-use_wallclock_as_timestamps',
      '1',
      '-r',
      '30',
      '-f',
      'h264',
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'copy',
      '-f',
      'mpegts',
      '-muxdelay',
      '0',
      '-muxpreload',
      '0',
      '-mpegts_flags',
      '+resend_headers',
      '-flush_packets',
      '1',
      udpUrl,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  activeFfmpeg = ffmpeg;

  ffmpeg.on('error', (error) => {
    log(`Unable to start ffmpeg: ${error.message}`);
    socket.destroy();
  });
  ffmpeg.stderr.setEncoding('utf8');
  ffmpeg.stderr.on('data', (chunk) => {
    for (const line of chunk.trim().split('\n')) {
      if (line) log(`ffmpeg: ${line}`);
    }
  });
  ffmpeg.on('exit', (code, signal) => {
    if (activeFfmpeg === ffmpeg) activeFfmpeg = null;
    if (!socket.destroyed) socket.destroy();
    log(`ffmpeg stopped (${signal ?? `exit ${code}`}).`);
  });

  socket.on('data', (chunk) => {
    byteCount += chunk.length;
    if (!ffmpeg.stdin.write(chunk)) socket.pause();
  });
  ffmpeg.stdin.on('drain', () => socket.resume());
  socket.on('error', (error) => log(`Quest TCP error: ${error.message}`));
  socket.on('close', () => {
    if (activeSocket === socket) {
      activeSocket = null;
      if (activeFfmpeg === ffmpeg) {
        activeFfmpeg = null;
        ffmpeg.stdin.end();
        ffmpeg.kill('SIGTERM');
      }
      log('Quest disconnected; waiting for automatic reconnect.');
    }
  });

  log(`Quest connected from ${socket.remoteAddress}:${socket.remotePort}.`);
  log(`Relaying H.264 to OBS at udp://127.0.0.1:${obsPort}.`);
}

const server = net.createServer(startPipeline);
server.on('error', (error) => {
  log(`Receiver error: ${error.message}`);
  process.exitCode = 1;
});
server.listen(inputPort, '127.0.0.1', () => {
  log(`Listening for Quest H.264 on tcp://127.0.0.1:${inputPort}.`);
  log(`OBS Media Source: udp://127.0.0.1:${obsPort}?fifo_size=1000000&overrun_nonfatal=1`);
});

const metricsTimer = setInterval(() => {
  if (activeSocket == null) return;
  const delta = byteCount - lastByteCount;
  lastByteCount = byteCount;
  const megabitsPerSecond = (delta * 8) / 5_000_000;
  const seconds = Math.round((Date.now() - connectedAt) / 1000);
  log(`Streaming ${megabitsPerSecond.toFixed(2)} Mbps · ${seconds}s connected`);
}, 5000);
metricsTimer.unref();

function shutdown(signal) {
  log(`Received ${signal}; shutting down receiver.`);
  clearInterval(metricsTimer);
  stopPipeline('Capture pipeline stopped.');
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
