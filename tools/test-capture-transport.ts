import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { NativeCaptureReceiver } from '../server/native-capture-receiver.js';

const inputPort = 49252;
const obsPort = 49253;
const receiver = new NativeCaptureReceiver({
  enabled: true,
  autoStart: false,
  autoConfigureUsb: false,
  host: '127.0.0.1',
  inputPort,
  obsPort,
  webPort: 8081,
  ffmpegBinary: process.env.FFMPEG_BIN?.trim() || 'ffmpeg',
  stallThresholdMs: 1500,
});

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function sendSyntheticVideo(udpPackets: Buffer[]): Promise<void> {
  const packetCountBefore = udpPackets.length;
  const ffmpeg = spawn(
    process.env.FFMPEG_BIN?.trim() || 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-re',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=30',
      '-t',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-f',
      'h264',
      `tcp://127.0.0.1:${inputPort}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  ffmpeg.stderr.setEncoding('utf8');
  ffmpeg.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  await waitFor(() => receiver.status().videoActive, 'active synthetic H.264');
  await new Promise<void>((resolve, reject) => {
    ffmpeg.once('error', reject);
    ffmpeg.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Synthetic FFmpeg exited ${code}: ${stderr.trim()}`));
    });
  });
  await waitFor(
    () => udpPackets.length > packetCountBefore,
    'MPEG-TS packets from the relay',
  );
  await waitFor(() => !receiver.status().receiverConnected, 'sender disconnect');
}

async function verifyMpegTs(packets: Buffer[]): Promise<number> {
  const ffprobe = spawn(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'json',
      '-i',
      'pipe:0',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  ffprobe.stdout.setEncoding('utf8');
  ffprobe.stderr.setEncoding('utf8');
  ffprobe.stdout.on('data', (chunk: string) => (stdout += chunk));
  ffprobe.stderr.on('data', (chunk: string) => (stderr += chunk));
  for (const packet of packets) ffprobe.stdin.write(packet);
  ffprobe.stdin.end();
  await new Promise<void>((resolve, reject) => {
    ffprobe.once('error', reject);
    ffprobe.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFprobe exited ${code}: ${stderr.trim()}`));
    });
  });
  const result = JSON.parse(stdout) as { streams?: Array<{ nb_read_frames?: string }> };
  return Number.parseInt(result.streams?.[0]?.nb_read_frames ?? '0', 10);
}

const udpPackets: Buffer[] = [];
const udpSocket = dgram.createSocket('udp4');
udpSocket.on('message', (packet) => udpPackets.push(Buffer.from(packet)));
try {
  await new Promise<void>((resolve, reject) => {
    udpSocket.once('error', reject);
    udpSocket.bind(obsPort, '127.0.0.1', resolve);
  });
  await receiver.start();
  await sendSyntheticVideo(udpPackets);
  await sendSyntheticVideo(udpPackets);
  const status = receiver.status();
  if (status.reconnectCount < 1) throw new Error('Receiver did not record a reconnect.');
  if (status.bytesReceived === 0) throw new Error('Receiver did not count video bytes.');
  const decodedFrames = await verifyMpegTs(udpPackets);
  if (decodedFrames < 10) throw new Error(`Only ${decodedFrames} relayed frames decoded.`);
  console.log(
    JSON.stringify({
      ok: true,
      bytesReceived: status.bytesReceived,
      udpPackets: udpPackets.length,
      decodedFrames,
      reconnectCount: status.reconnectCount,
      obsInputUrl: status.obsInputUrl,
    }),
  );
} finally {
  udpSocket.close();
  await receiver.stop();
}
