import { chmodSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  adbDevices,
  executable,
  prerequisiteHint,
  projectRoot,
  releaseApk,
  run,
  supportedDesktop,
  supportedNode,
} from './local-toolkit.mjs';

console.log('\nHoloHangout first-time setup\n');
const verifyOnly = process.argv.includes('--verify');
if (!supportedDesktop) {
  console.error('HoloHangout local tooling supports Windows and macOS.');
  process.exit(1);
}
if (!supportedNode()) {
  console.error(`Node ${process.versions.node} is unsupported. Install a version allowed by package.json (Node 22.19.0 is recommended).`);
  process.exit(1);
}

if (!verifyOnly) {
  console.log('Installing exact project dependencies…');
  const install = run('npm', ['ci'], { stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status ?? 1);
} else {
  console.log('· Verification mode: dependency installation skipped.');
}

const envPath = join(projectRoot, '.env');
if (!existsSync(envPath) && !verifyOnly) {
  copyFileSync(join(projectRoot, '.env.example'), envPath);
  if (process.platform !== 'win32') chmodSync(envPath, 0o600);
  console.log('✓ Created private .env from .env.example (existing files are never overwritten).');
} else if (existsSync(envPath)) {
  console.log('✓ Existing .env preserved.');
} else {
  console.log('! .env is missing; normal setup would create it from .env.example.');
}

console.log(executable('adb')
  ? '✓ ADB is available.'
  : `! ADB is missing; ${prerequisiteHint('adb')}.`);
console.log(executable('ffmpeg')
  ? '✓ FFmpeg is available.'
  : `! FFmpeg is missing; ${prerequisiteHint('ffmpeg')}.`);
console.log(existsSync(releaseApk)
  ? '✓ Prebuilt HoloHangout Capture APK is available.'
  : '! Prebuilt APK is missing. This checkout is not release-ready.');

const authorized = adbDevices().filter(({ state }) => state === 'device');
if (process.argv.includes('--install-apk') && !verifyOnly) {
  if (!existsSync(releaseApk) || authorized.length === 0) {
    console.error('APK installation requires the release APK and an authorized USB-connected Quest.');
    process.exit(1);
  }
  console.log('Installing HoloHangout Capture on the connected Quest…');
  const installed = run('adb', ['install', '-r', releaseApk], { stdio: 'inherit' });
  if (installed.status !== 0) process.exit(installed.status ?? 1);
}

console.log(`
Next steps:
1. Add your Twitch Client ID and Client Secret to .env (docs/TWITCH.md).
2. Connect Quest by USB and approve USB debugging.
3. Install the APK once with: npm run capture:install:release
4. Configure OBS using docs/QUEST-OBS.md.
5. Start each session with: npm run start:holohangout

Run npm run check at any time for a local readiness report.
`);
