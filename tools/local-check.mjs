import { existsSync } from 'node:fs';
import {
  adbDevices,
  dashboardUrl,
  envKeys,
  executable,
  obsInstalled,
  portInUse,
  prerequisiteHint,
  questUrl,
  releaseApk,
  supportedDesktop,
  supportedNode,
} from './local-toolkit.mjs';

const rows = [];
const add = (level, label, detail) => rows.push({ level, label, detail });

add(supportedDesktop ? 'ok' : 'error', 'Operating system',
  supportedDesktop ? `${process.platform === 'win32' ? 'Windows' : 'macOS'} ${process.arch}` : `${process.platform} is not supported`);
add(supportedNode() ? 'ok' : 'error', 'Node.js',
  supportedNode() ? process.versions.node : `${process.versions.node}; Node 22.19.0 is recommended`);

const env = envKeys();
add(env.size > 0 ? 'ok' : 'error', 'Local configuration',
  env.size > 0 ? '.env found' : 'missing .env; run npm run setup');
for (const key of ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET']) {
  add(env.get(key) ? 'ok' : 'warn', key,
    env.get(key) ? 'configured' : 'missing; Twitch connection will remain unavailable');
}

add(executable('adb') ? 'ok' : 'error', 'ADB',
  executable('adb') ? 'available' : prerequisiteHint('adb'));
add(executable('ffmpeg') ? 'ok' : 'error', 'FFmpeg',
  executable('ffmpeg') ? 'available' : prerequisiteHint('ffmpeg'));
add(obsInstalled() ? 'ok' : 'warn', 'OBS Studio',
  obsInstalled() ? 'installed' : 'not found in the standard installation location');
add(existsSync(releaseApk) ? 'ok' : 'error', 'HoloHangout Capture APK',
  existsSync(releaseApk) ? 'release/HoloHangout-Capture.apk' : 'missing release APK');

const devices = adbDevices();
const authorized = devices.filter(({ state }) => state === 'device');
add(authorized.length > 0 ? 'ok' : 'warn', 'Quest USB',
  authorized.length > 0
    ? `${authorized.length} authorized Android device${authorized.length === 1 ? '' : 's'}`
    : devices.some(({ state }) => state === 'unauthorized')
      ? 'device found; approve USB debugging inside the headset'
      : 'no authorized device connected');

const dashboardRunning = await portInUse(8787);
const webxrRunning = await portInUse(8081);
add(dashboardRunning ? 'ok' : 'info', 'Dashboard', dashboardRunning ? dashboardUrl : 'not running');
add(webxrRunning ? 'ok' : 'info', 'Quest world', webxrRunning ? questUrl : 'not running');
const obsWebSocketRunning = await portInUse(4455);
add(obsWebSocketRunning ? 'ok' : 'warn', 'OBS WebSocket',
  obsWebSocketRunning ? 'listening on 127.0.0.1:4455' : 'not listening; open OBS and enable WebSocket server');

for (const { level, label, detail } of rows) {
  const mark = level === 'ok' ? '✓' : level === 'error' ? '✗' : level === 'warn' ? '!' : '·';
  console.log(`${mark} ${label}: ${detail}`);
}

const errors = rows.filter(({ level }) => level === 'error').length;
console.log(errors === 0
  ? '\nHoloHangout is ready to launch. Run: npm run start:holohangout'
  : `\n${errors} required item${errors === 1 ? '' : 's'} need attention. See docs/TROUBLESHOOTING.md.`);
process.exitCode = errors === 0 ? 0 : 1;
