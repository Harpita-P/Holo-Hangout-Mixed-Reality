import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NativeCaptureReceiver,
  obsInputUrl,
  type NativeCaptureConfig,
} from './native-capture-receiver.js';

const config: NativeCaptureConfig = {
  enabled: true,
  autoStart: false,
  autoConfigureUsb: false,
  host: '127.0.0.1',
  inputPort: 0,
  obsPort: 49153,
  webPort: 8081,
  ffmpegBinary: 'ffmpeg',
  stallThresholdMs: 3000,
};

test('receiver exposes its local transport and starts inactive', () => {
  const receiver = new NativeCaptureReceiver(config);
  const status = receiver.status();
  assert.equal(status.listening, false);
  assert.equal(status.videoActive, false);
  assert.equal(status.receiverConnected, false);
  assert.equal(status.obsPort, 49153);
});

test('disabled receiver cannot be started accidentally', async () => {
  const receiver = new NativeCaptureReceiver({ ...config, enabled: false });
  await assert.rejects(() => receiver.start(), /QUEST_CAPTURE_ENABLED=true/u);
  assert.equal(receiver.status().enabled, false);
});

test('OBS URL uses a bounded local UDP transport', () => {
  assert.equal(
    obsInputUrl(49153),
    'udp://127.0.0.1:49153?fifo_size=1000000&overrun_nonfatal=1',
  );
});
