import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ObsController,
  type ObsConfig,
  type ObsTransport,
} from './obs-controller.js';

class FakeObsTransport implements ObsTransport {
  streamActive = false;
  currentScene = 'Starting Soon';
  scenes = ['Starting Soon', 'ChatIRL Live'];
  inputs = ['MQDH Cast', 'Streamer Mic'];
  enabledSceneSources = ['MQDH Cast'];
  mediaState: string | null = null;
  selectedScenes: string[] = [];
  audioOffsets: Array<{ inputName: string; offsetMs: number }> = [];
  startCalls = 0;
  stopCalls = 0;
  private disconnected = (_message: string): void => undefined;
  private streamChanged = (_active: boolean): void => undefined;

  async connect(): Promise<string> {
    return '31.0.0';
  }

  async disconnect(): Promise<void> {}

  async getStreamStatus(): Promise<{
    outputActive: boolean;
    outputReconnecting: boolean;
    outputTimecode: string;
  }> {
    return {
      outputActive: this.streamActive,
      outputReconnecting: false,
      outputTimecode: this.streamActive ? '00:00:05.000' : '00:00:00.000',
    };
  }

  async getCurrentProgramScene(): Promise<string> {
    return this.currentScene;
  }

  async getSceneNames(): Promise<string[]> {
    return this.scenes;
  }

  async getInputNames(): Promise<string[]> {
    return this.inputs;
  }

  async getEnabledSceneSourceNames(): Promise<string[]> {
    return this.enabledSceneSources;
  }

  async getMediaInputState(): Promise<string | null> {
    return this.mediaState;
  }

  async setSceneSourceEnabled(
    _sceneName: string,
    sourceName: string,
    enabled: boolean,
  ): Promise<boolean> {
    if (!this.inputs.includes(sourceName)) return false;
    if (enabled && !this.enabledSceneSources.includes(sourceName)) {
      this.enabledSceneSources.push(sourceName);
    }
    if (!enabled) {
      this.enabledSceneSources = this.enabledSceneSources.filter(
        (candidate) => candidate !== sourceName,
      );
    }
    return true;
  }

  async setCurrentProgramScene(sceneName: string): Promise<void> {
    this.currentScene = sceneName;
    this.selectedScenes.push(sceneName);
  }

  async setInputAudioSyncOffset(inputName: string, offsetMs: number): Promise<void> {
    this.audioOffsets.push({ inputName, offsetMs });
  }

  async startStream(): Promise<void> {
    this.startCalls += 1;
    this.streamActive = true;
    this.streamChanged(true);
  }

  async stopStream(): Promise<void> {
    this.stopCalls += 1;
    this.streamActive = false;
    this.streamChanged(false);
  }

  onDisconnected(handler: (message: string) => void): void {
    this.disconnected = handler;
  }

  onStreamStateChanged(handler: (active: boolean) => void): void {
    this.streamChanged = handler;
  }
}

const config: ObsConfig = {
  enabled: true,
  url: 'ws://127.0.0.1:4455',
  password: 'test-only',
  sceneName: 'ChatIRL Live',
  nativeCaptureSourceName: 'Quest Capture Feed',
  fallbackCaptureSourceName: 'MQDH Cast',
  microphoneSourceName: 'Streamer Mic',
  microphoneSyncOffsetMs: 180,
};

test('start stream selects the validated scene and applies microphone delay', async () => {
  const transport = new FakeObsTransport();
  const controller = new ObsController(config, () => undefined, transport);

  await controller.reconnect();
  const status = await controller.startStream();

  assert.equal(status.streaming, true);
  assert.equal(status.currentScene, 'ChatIRL Live');
  assert.deepEqual(transport.selectedScenes, ['ChatIRL Live']);
  assert.deepEqual(transport.audioOffsets, [
    { inputName: 'Streamer Mic', offsetMs: 180 },
  ]);
  assert.equal(transport.startCalls, 1);
  await controller.stop();
});

test('preflight blocks a stream when no capture source is enabled in the scene', async () => {
  const transport = new FakeObsTransport();
  transport.enabledSceneSources = [];
  const controller = new ObsController(config, () => undefined, transport);

  const connected = await controller.reconnect();
  assert.equal(connected.ready, false);
  await assert.rejects(() => controller.startStream(), /Quest Capture Feed|MQDH Cast/u);
  assert.equal(transport.startCalls, 0);
  await controller.stop();
});

test('native Quest capture is preferred only when bytes are active and OBS is playing it', async () => {
  const transport = new FakeObsTransport();
  transport.inputs = ['Quest Capture Feed', 'MQDH Cast', 'Streamer Mic'];
  transport.enabledSceneSources = ['Quest Capture Feed', 'MQDH Cast'];
  transport.mediaState = 'OBS_MEDIA_STATE_PLAYING';
  const controller = new ObsController(
    config,
    () => undefined,
    transport,
    () => ({
      enabled: true,
      videoActive: true,
      stalled: false,
      message: 'Quest video is active and relaying to OBS.',
    }),
  );

  const status = await controller.reconnect();
  assert.equal(status.ready, true);
  assert.equal(status.captureMode, 'native');
  assert.equal(status.captureSourceName, 'Quest Capture Feed');
  assert.equal(status.nativeMediaState, 'OBS_MEDIA_STATE_PLAYING');
  await controller.stop();
});

test('an existing native source is not considered ready when its feed is stalled', async () => {
  const transport = new FakeObsTransport();
  transport.inputs = ['Quest Capture Feed', 'Streamer Mic'];
  transport.enabledSceneSources = ['Quest Capture Feed'];
  transport.mediaState = 'OBS_MEDIA_STATE_PLAYING';
  const controller = new ObsController(
    config,
    () => undefined,
    transport,
    () => ({
      enabled: true,
      videoActive: false,
      stalled: true,
      message: 'Encoded video stalled for more than 3 seconds.',
    }),
  );

  const status = await controller.reconnect();
  assert.equal(status.ready, false);
  assert.equal(status.captureMode, 'none');
  assert.match(status.error ?? '', /stalled/u);
  await assert.rejects(() => controller.startStream(), /stalled/u);
  await controller.stop();
});

test('MQDH remains available as fallback when native capture is not healthy', async () => {
  const transport = new FakeObsTransport();
  transport.inputs = ['Quest Capture Feed', 'MQDH Cast', 'Streamer Mic'];
  transport.enabledSceneSources = ['Quest Capture Feed', 'MQDH Cast'];
  transport.mediaState = 'OBS_MEDIA_STATE_STOPPED';
  const controller = new ObsController(
    config,
    () => undefined,
    transport,
    () => ({
      enabled: true,
      videoActive: false,
      stalled: false,
      message: 'Waiting for Quest video.',
    }),
  );

  const status = await controller.reconnect();
  assert.equal(status.ready, true);
  assert.equal(status.captureMode, 'mqdh');
  assert.equal(status.captureSourceName, 'MQDH Cast');
  await controller.stop();
});

test('dashboard capture selection switches cleanly between native and MQDH sources', async () => {
  const transport = new FakeObsTransport();
  transport.inputs = ['Quest Capture Feed', 'MQDH Cast', 'Streamer Mic'];
  transport.enabledSceneSources = ['MQDH Cast'];
  transport.mediaState = 'OBS_MEDIA_STATE_PLAYING';
  const controller = new ObsController(
    config,
    () => undefined,
    transport,
    () => ({
      enabled: true,
      videoActive: true,
      stalled: false,
      message: 'Quest video is active and relaying to OBS.',
    }),
  );

  await controller.reconnect();
  assert.equal((await controller.selectCapture('native')).captureMode, 'native');
  assert.deepEqual(transport.enabledSceneSources, ['Quest Capture Feed']);
  assert.equal((await controller.selectCapture('mqdh')).captureMode, 'mqdh');
  assert.deepEqual(transport.enabledSceneSources, ['MQDH Cast']);
  await controller.stop();
});

test('stop stream is idempotent and updates status', async () => {
  const transport = new FakeObsTransport();
  transport.streamActive = true;
  const controller = new ObsController(config, () => undefined, transport);

  await controller.reconnect();
  assert.equal((await controller.stopStream()).streaming, false);
  assert.equal((await controller.stopStream()).streaming, false);
  assert.equal(transport.stopCalls, 1);
  await controller.stop();
});
