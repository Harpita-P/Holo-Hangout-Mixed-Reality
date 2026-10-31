import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const projectRoot = resolve(import.meta.dirname, '..');
export const dashboardUrl = 'http://localhost:8787';
export const questUrl = 'https://localhost:8081/';
export const releaseApk = join(projectRoot, 'release', 'HoloHangout-Capture.apk');
export const supportedDesktop = process.platform === 'darwin' || process.platform === 'win32';

export function supportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24;
}

export function executable(name) {
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return (process.env.PATH ?? '').split(delimiter).some((directory) =>
    suffixes.some((suffix) => existsSync(join(directory.replace(/^"|"$/gu, ''), `${name}${suffix}`))),
  );
}

export function envKeys() {
  const path = join(projectRoot, '.env');
  if (!existsSync(path)) return new Map();
  const values = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/u);
    if (match) values.set(match[1], match[2].replace(/^['"]|['"]$/gu, ''));
  }
  return values;
}

export function adbDevices() {
  if (!executable('adb')) return [];
  const result = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  return (result.stdout ?? '')
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => parts.length >= 2)
    .map(([serial, state]) => ({ serial, state }));
}

export function obsInstalled() {
  if (process.platform === 'darwin') {
    return existsSync('/Applications/OBS.app') || existsSync('/Applications/OBS Studio.app');
  }
  if (process.platform === 'win32') {
    return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(Boolean)
      .some((root) =>
        existsSync(join(root, 'obs-studio', 'bin', '64bit', 'obs64.exe')) ||
        existsSync(join(root, 'Programs', 'obs-studio', 'bin', '64bit', 'obs64.exe')),
      );
  }
  return executable('obs');
}

export function portInUse(port, host = '127.0.0.1', timeoutMs = 250) {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

export function run(command, args, options = {}) {
  const invocation = commandInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, {
    cwd: projectRoot,
    encoding: 'utf8',
    ...options,
  });
}

export function commandInvocation(command, args = []) {
  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args],
    };
  }
  return { command, args };
}

export function prerequisiteHint(command) {
  if (process.platform === 'win32') {
    if (command === 'adb') return 'install Android SDK Platform Tools and add platform-tools to PATH';
    if (command === 'ffmpeg') return 'install FFmpeg and add its bin folder to PATH';
  }
  if (command === 'adb') return 'install with: brew install android-platform-tools';
  if (command === 'ffmpeg') return 'install with: brew install ffmpeg';
  return `install ${command} and add it to PATH`;
}
