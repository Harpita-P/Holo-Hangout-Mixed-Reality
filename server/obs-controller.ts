import { OBSWebSocket } from 'obs-websocket-js';

export interface ObsConfig {
  enabled: boolean;
  url: string;
  password: string;
  sceneName: string;
  captureSourceName: string;
  microphoneSourceName: string | null;
  microphoneSyncOffsetMs: number;
}

export interface ObsStatus {
  enabled: boolean;
  connected: boolean;
  ready: boolean;
  streaming: boolean;
  reconnecting: boolean;
  outputTimecode: string;
  currentScene: string | null;
  targetScene: string;
  targetSceneAvailable: boolean;
  captureSourceName: string;
  captureSourceAvailable: boolean;
  microphoneSourceName: string | null;
  microphoneSourceAvailable: boolean | null;
  microphoneSyncOffsetMs: number;
  obsVersion: string | null;
  error: string | null;
}

export interface ObsTransport {
  connect(url: string, password?: string): Promise<string>;
  disconnect(): Promise<void>;
  getStreamStatus(): Promise<{
    outputActive: boolean;
    outputReconnecting: boolean;
    outputTimecode: string;
  }>;
  getCurrentProgramScene(): Promise<string>;
  getSceneNames(): Promise<string[]>;
  getInputNames(): Promise<string[]>;
  getEnabledSceneSourceNames(sceneName: string): Promise<string[]>;
  setCurrentProgramScene(sceneName: string): Promise<void>;
  setInputAudioSyncOffset(inputName: string, offsetMs: number): Promise<void>;
  startStream(): Promise<void>;
  stopStream(): Promise<void>;
  onDisconnected(handler: (message: string) => void): void;
  onStreamStateChanged(handler: (active: boolean) => void): void;
}

class ObsWebSocketTransport implements ObsTransport {
  private readonly client = new OBSWebSocket();

  async connect(url: string, password?: string): Promise<string> {
    const result = await this.client.connect(url, password || undefined, {
      rpcVersion: 1,
    });
    return result.obsWebSocketVersion;
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  async getStreamStatus(): Promise<{
    outputActive: boolean;
    outputReconnecting: boolean;
    outputTimecode: string;
  }> {
    const result = await this.client.call('GetStreamStatus');
    return {
      outputActive: result.outputActive,
      outputReconnecting: result.outputReconnecting,
      outputTimecode: result.outputTimecode,
    };
  }

  async getCurrentProgramScene(): Promise<string> {
    return (await this.client.call('GetCurrentProgramScene')).currentProgramSceneName;
  }

  async getSceneNames(): Promise<string[]> {
    return (await this.client.call('GetSceneList')).scenes
      .map(({ sceneName }) => sceneName)
      .filter((sceneName): sceneName is string => typeof sceneName === 'string');
  }

  async getInputNames(): Promise<string[]> {
    return (await this.client.call('GetInputList')).inputs
      .map(({ inputName }) => inputName)
      .filter((inputName): inputName is string => typeof inputName === 'string');
  }

  async getEnabledSceneSourceNames(sceneName: string): Promise<string[]> {
    return (await this.client.call('GetSceneItemList', { sceneName })).sceneItems
      .filter(({ sceneItemEnabled }) => sceneItemEnabled === true)
      .map(({ sourceName }) => sourceName)
      .filter((sourceName): sourceName is string => typeof sourceName === 'string');
  }

  async setCurrentProgramScene(sceneName: string): Promise<void> {
    await this.client.call('SetCurrentProgramScene', { sceneName });
  }

  async setInputAudioSyncOffset(inputName: string, offsetMs: number): Promise<void> {
    await this.client.call('SetInputAudioSyncOffset', {
      inputName,
      inputAudioSyncOffset: offsetMs,
    });
  }

  async startStream(): Promise<void> {
    await this.client.call('StartStream');
  }

  async stopStream(): Promise<void> {
    await this.client.call('StopStream');
  }

  onDisconnected(handler: (message: string) => void): void {
    this.client.on('ConnectionClosed', (error) => handler(error.message));
  }

  onStreamStateChanged(handler: (active: boolean) => void): void {
    this.client.on('StreamStateChanged', ({ outputActive }) => handler(outputActive));
  }
}

export class ObsController {
  private readonly transport: ObsTransport;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private connecting: Promise<void> | null = null;
  private state: ObsStatus;

  constructor(
    private readonly config: ObsConfig,
    private readonly onChange: (status: ObsStatus) => void = () => undefined,
    transport?: ObsTransport,
  ) {
    this.transport = transport ?? new ObsWebSocketTransport();
    this.state = {
      enabled: config.enabled,
      connected: false,
      ready: false,
      streaming: false,
      reconnecting: false,
      outputTimecode: '00:00:00.000',
      currentScene: null,
      targetScene: config.sceneName,
      targetSceneAvailable: false,
      captureSourceName: config.captureSourceName,
      captureSourceAvailable: false,
      microphoneSourceName: config.microphoneSourceName,
      microphoneSourceAvailable: config.microphoneSourceName == null ? null : false,
      microphoneSyncOffsetMs: config.microphoneSyncOffsetMs,
      obsVersion: null,
      error: config.enabled ? null : 'OBS integration is disabled in .env.',
    };
    this.transport.onDisconnected((message) => this.handleDisconnect(message));
    this.transport.onStreamStateChanged((active) => {
      this.patch({ streaming: active });
      this.refresh().catch((error) => this.handleError(error));
    });
  }

  status(): ObsStatus {
    return { ...this.state };
  }

  start(): void {
    if (this.config.enabled) this.connect().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.state.connected) await this.transport.disconnect();
    this.patch({ connected: false, ready: false });
  }

  async reconnect(): Promise<ObsStatus> {
    if (!this.config.enabled) throw new Error('Set OBS_ENABLED=true in .env first.');
    this.stopped = true;
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.state.connected) await this.transport.disconnect();
    this.stopped = false;
    this.patch({ connected: false, ready: false, error: null });
    await this.connect();
    return this.status();
  }

  async refresh(): Promise<ObsStatus> {
    if (!this.state.connected) return this.status();
    const [stream, currentScene, sceneNames, inputNames] = await Promise.all([
      this.transport.getStreamStatus(),
      this.transport.getCurrentProgramScene(),
      this.transport.getSceneNames(),
      this.transport.getInputNames(),
    ]);
    const targetSceneAvailable = sceneNames.includes(this.config.sceneName);
    const enabledSceneSources = targetSceneAvailable
      ? await this.transport.getEnabledSceneSourceNames(this.config.sceneName)
      : [];
    const captureSourceAvailable =
      inputNames.includes(this.config.captureSourceName) &&
      enabledSceneSources.includes(this.config.captureSourceName);
    const microphoneSourceAvailable =
      this.config.microphoneSourceName == null
        ? null
        : inputNames.includes(this.config.microphoneSourceName);
    const ready =
      targetSceneAvailable &&
      captureSourceAvailable &&
      microphoneSourceAvailable !== false;
    this.patch({
      ready,
      streaming: stream.outputActive,
      reconnecting: stream.outputReconnecting,
      outputTimecode: stream.outputTimecode,
      currentScene,
      targetSceneAvailable,
      captureSourceAvailable,
      microphoneSourceAvailable,
      error: ready ? null : this.preflightError({
        targetSceneAvailable,
        captureSourceAvailable,
        microphoneSourceAvailable,
      }),
    });
    return this.status();
  }

  async startStream(): Promise<ObsStatus> {
    await this.ensureConnected();
    const status = await this.refresh();
    if (!status.ready) throw new Error(status.error ?? 'OBS preflight failed.');
    if (status.currentScene !== this.config.sceneName) {
      await this.transport.setCurrentProgramScene(this.config.sceneName);
    }
    if (
      this.config.microphoneSourceName != null &&
      this.config.microphoneSyncOffsetMs !== 0
    ) {
      await this.transport.setInputAudioSyncOffset(
        this.config.microphoneSourceName,
        this.config.microphoneSyncOffsetMs,
      );
    }
    if (!status.streaming) await this.transport.startStream();
    return this.refresh();
  }

  async stopStream(): Promise<ObsStatus> {
    await this.ensureConnected();
    const status = await this.refresh();
    if (status.streaming) await this.transport.stopStream();
    return this.refresh();
  }

  private async ensureConnected(): Promise<void> {
    if (!this.config.enabled) throw new Error('OBS integration is disabled in .env.');
    if (!this.state.connected) await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.connecting != null) return this.connecting;
    this.connecting = this.connectOnce()
      .catch((error) => {
        this.handleError(error);
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private async connectOnce(): Promise<void> {
    const obsVersion = await this.transport.connect(
      this.config.url,
      this.config.password || undefined,
    );
    if (this.stopped) {
      await this.transport.disconnect();
      return;
    }
    this.patch({ connected: true, obsVersion, error: null });
    await this.refresh();
  }

  private handleDisconnect(message: string): void {
    this.patch({
      connected: false,
      ready: false,
      streaming: false,
      reconnecting: false,
      error: message || 'OBS disconnected.',
    });
    this.scheduleReconnect();
  }

  private handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.patch({
      connected: false,
      ready: false,
      streaming: false,
      reconnecting: false,
      error: message,
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.config.enabled || this.reconnectTimer != null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => undefined);
    }, 2500);
    this.reconnectTimer.unref();
  }

  private preflightError(values: {
    targetSceneAvailable: boolean;
    captureSourceAvailable: boolean;
    microphoneSourceAvailable: boolean | null;
  }): string {
    if (!values.targetSceneAvailable) {
      return `Create an OBS scene named “${this.config.sceneName}”.`;
    }
    if (!values.captureSourceAvailable) {
      return `Add and enable the MQDH window source in “${this.config.sceneName}”, named “${this.config.captureSourceName}”.`;
    }
    if (values.microphoneSourceAvailable === false) {
      return `OBS microphone source “${this.config.microphoneSourceName}” was not found.`;
    }
    return 'OBS preflight failed.';
  }

  private patch(values: Partial<ObsStatus>): void {
    this.state = { ...this.state, ...values };
    this.onChange(this.status());
  }
}
