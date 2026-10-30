import 'dotenv/config';
import { NativeCaptureReceiver } from '../server/native-capture-receiver.js';

function port(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : fallback;
}

let lastLine = '';
const receiver = new NativeCaptureReceiver(
  {
    enabled: true,
    autoStart: true,
    autoConfigureUsb: false,
    host: '127.0.0.1',
    inputPort: port('QUEST_CAPTURE_PORT', 49152),
    obsPort: port('QUEST_CAPTURE_OBS_UDP_PORT', 49153),
    webPort: port('CHATIRL_HTTPS_PORT', 8081),
    ffmpegBinary: process.env.FFMPEG_BIN?.trim() || 'ffmpeg',
    stallThresholdMs: 3000,
  },
  (status) => {
    const bitrate = status.videoActive ? ` · ${status.bitrateMbps.toFixed(2)} Mbps` : '';
    const line = `${status.message}${bitrate}`;
    if (line !== lastLine) {
      lastLine = line;
      console.log(`[${new Date().toISOString()}] ${line}`);
    }
    if (status.error != null && !line.includes(status.error)) {
      console.error(`[capture] ${status.error}`);
    }
  },
);

await receiver.start();
console.log(`OBS Media Source: ${receiver.status().obsInputUrl}`);

async function shutdown(): Promise<void> {
  await receiver.stop();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
