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
  throw new Error('Set JAVA_HOME to a Java 11 installation before building.');
}

function resolveAndroidSdk() {
  const configured = process.env.ANDROID_HOME?.trim() || process.env.ANDROID_SDK_ROOT?.trim();
  if (configured) return configured;
  const macDefault = join(homedir(), 'Library', 'Android', 'sdk');
  if (existsSync(macDefault)) return macDefault;
  throw new Error('Set ANDROID_HOME to the installed Android SDK.');
}

const result = spawnSync('./gradlew', ['testDebugUnitTest', 'assembleDebug'], {
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
