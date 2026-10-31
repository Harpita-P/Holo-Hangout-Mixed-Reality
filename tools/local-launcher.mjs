import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  adbDevices,
  commandInvocation,
  dashboardUrl,
  executable,
  portInUse,
  projectRoot,
  questUrl,
  run,
  supportedDesktop,
  supportedNode,
} from './local-toolkit.mjs';

if (!supportedDesktop || !supportedNode()) {
  console.error('HoloHangout requires Windows or macOS and a supported Node.js version. Run npm run check.');
  process.exit(1);
}
if (!existsSync(join(projectRoot, '.env'))) {
  console.error('Missing .env. Run npm run setup first.');
  process.exit(1);
}
for (const port of [8787, 8081, 49152]) {
  if (await portInUse(port)) {
    console.error(`Port ${port} is already in use. Stop the older HoloHangout process and try again.`);
    process.exit(1);
  }
}
for (const command of ['adb', 'ffmpeg']) {
  if (!executable(command)) {
    console.error(`Missing ${command}. Run npm run check for installation instructions.`);
    process.exit(1);
  }
}

const dryRun = process.argv.includes('--dry-run');
const devices = adbDevices().filter(({ state }) => state === 'device');
if (devices.length > 0 && !dryRun) {
  for (const port of [8081, 49152]) {
    const reverse = run('adb', ['reverse', `tcp:${port}`, `tcp:${port}`]);
    if (reverse.status !== 0) console.warn(`Unable to configure ADB reverse for port ${port}.`);
  }
  console.log(`✓ USB forwarding configured for ${devices[0].serial}.`);
} else if (devices.length === 0) {
  console.warn('! No authorized Quest detected. HoloHangout will start; connect Quest and use Configure USB in the dashboard.');
}

if (dryRun) {
  console.log(`
Dry run passed. The launcher would now start:
- npm run server
- npm run dev:launcher
- Dashboard: ${dashboardUrl}
- Quest Browser: ${questUrl}
`);
  process.exit(0);
}

const children = [];
const startChild = (label, args) => {
  const invocation = commandInvocation('npm', args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
    detached: process.platform !== 'win32',
  });
  child.on('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`${label} stopped unexpectedly (${signal ?? code}).`);
      void shutdown(1);
    }
  });
  children.push(child);
};

let stopping = false;
startChild('Local control server', ['run', 'server']);
startChild('WebXR frontend', ['run', 'dev:launcher']);

const waitFor = (url, secure = false) => new Promise((resolvePromise, reject) => {
  const started = Date.now();
  const poll = () => {
    const client = secure ? https : http;
    const request = client.get(url, secure ? { rejectUnauthorized: false } : {}, (response) => {
      response.resume();
      if ((response.statusCode ?? 500) < 500) return resolvePromise();
      retry();
    });
    request.once('error', retry);
  };
  const retry = () => {
    if (Date.now() - started > 45_000) return reject(new Error(`${url} did not become ready in 45 seconds.`));
    setTimeout(poll, 500);
  };
  poll();
});

try {
  await Promise.all([waitFor(`${dashboardUrl}/status`), waitFor(questUrl, true)]);
  console.log(`
HoloHangout is ready.
Dashboard: ${dashboardUrl}
Quest Browser: ${questUrl}

Keep this Terminal window open. Press Control-C to stop HoloHangout cleanly.
`);
  if (process.platform === 'darwin') run('open', [dashboardUrl]);
  else run('cmd.exe', ['/d', '/s', '/c', 'start', '', dashboardUrl]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await shutdown(1);
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping HoloHangout…');
  for (const child of children) {
    if (process.platform === 'win32') {
      run('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
  run('npm', ['run', 'dev:down']);
  process.exit(exitCode);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
