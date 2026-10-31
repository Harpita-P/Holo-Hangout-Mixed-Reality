import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const androidProject = join(projectRoot, 'quest-capture');

function resolveJavaHome() {
  if (process.env.JAVA_HOME?.trim()) return process.env.JAVA_HOME.trim();
  if (process.platform === 'darwin') {
    return execFileSync('/usr/libexec/java_home', ['-v', '11'], { encoding: 'utf8' }).trim();
  }
  if (process.platform === 'win32') {
    const androidStudioJbr = join(process.env.ProgramFiles || 'C:\\Program Files', 'Android', 'Android Studio', 'jbr');
    if (existsSync(androidStudioJbr)) return androidStudioJbr;
  }
  throw new Error('Set JAVA_HOME to a compatible JDK before building HoloHangout Capture.');
}

function resolveAndroidSdk() {
  const configured = process.env.ANDROID_HOME?.trim() || process.env.ANDROID_SDK_ROOT?.trim();
  if (configured) return configured;
  const macDefault = join(homedir(), 'Library', 'Android', 'sdk');
  if (existsSync(macDefault)) return macDefault;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const windowsDefault = join(process.env.LOCALAPPDATA, 'Android', 'Sdk');
    if (existsSync(windowsDefault)) return windowsDefault;
  }
  throw new Error('Set ANDROID_HOME to the installed Android SDK.');
}

const gradleWrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const gradleCommand = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : gradleWrapper;
const gradleArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', gradleWrapper, 'testDebugUnitTest', 'assembleDebug']
  : ['testDebugUnitTest', 'assembleDebug'];
const result = spawnSync(gradleCommand, gradleArgs, {
  cwd: androidProject,
  env: {
    ...process.env,
    JAVA_HOME: resolveJavaHome(),
    ANDROID_HOME: resolveAndroidSdk(),
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
