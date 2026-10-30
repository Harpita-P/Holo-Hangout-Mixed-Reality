import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net, { type Server, type Socket } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NativeCaptureConfig {
  enabled: boolean;
  autoStart: boolean;
  autoConfigureUsb: boolean;
  host: string;
  inputPort: number;
  obsPort: number;
  webPort: number;
  ffmpegBinary: string;
  stallThresholdMs: number;
}

export interface NativeCaptureStatus {
  enabled: boolean;
  autoStart: boolean;
  listening: boolean;
  receiverConnected: boolean;
  ffmpegRunning: boolean;
  videoActive: boolean;
  stalled: boolean;
  inputPort: number;
  obsPort: number;
  obsInputUrl: string;
  bytesReceived: number;
  bitrateMbps: number;
  connectedAt: string | null;
  lastVideoDataAt: string | null;
  reconnectCount: number;
  adbConfigured: boolean;
  message: string;
  error: string | null;
}

export class NativeCaptureReceiver {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private ffmpeg: ChildProcessWithoutNullStreams | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private lastMetricBytes = 0;
  private lastMetricAt = Date.now();
  private connectedAtMs: number | null = null;
  private lastVideoDataAtMs: number | null = null;
  private connectionCount = 0;
  private state: NativeCaptureStatus;

  constructor(
    private readonly config: NativeCaptureConfig,
    private readonly onChange: (status: NativeCaptureStatus) => void = () => undefined,
  ) {
    this.state = {
      enabled: config.enabled,
      autoStart: config.autoStart,
      listening: false,
      receiverConnected: false,
      ffmpegRunning: false,
      videoActive: false,
      stalled: false,
      inputPort: config.inputPort,
      obsPort: config.obsPort,
      obsInputUrl: obsInputUrl(config.obsPort),
      bytesReceived: 0,
      bitrateMbps: 0,
      connectedAt: null,
      lastVideoDataAt: null,
      reconnectCount: 0,
      adbConfigured: false,
      message: config.enabled
        ? 'Receiver is stopped.'
        : 'Native Quest capture is disabled in .env.',
      error: null,
    };
  }

  status(): NativeCaptureStatus {
    return { ...this.state };
  }

  async start(): Promise<NativeCaptureStatus> {
    if (!this.config.enabled) {
      throw new Error('Set QUEST_CAPTURE_ENABLED=true in .env first.');
    }
    if (this.server != null) return this.status();

    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    server.on('error', (error) => {
      if (this.server === server) this.server = null;
      this.patch({
        listening: false,
        videoActive: false,
        message: 'Receiver failed.',
        error: error.message,
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(this.config.inputPort, this.config.host, () => {
        server.off('error', onError);
        resolve();
      });
    });

    this.patch({
      listening: true,
      message: 'Waiting for Quest capture permission and video.',
      error: null,
    });
    this.startMetrics();
    if (this.config.autoConfigureUsb) {
      await this.configureUsb().catch((error: unknown) => {
        this.patch({
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return this.status();
  }

  async restart(): Promise<NativeCaptureStatus> {
    await this.stop();
    return this.start();
  }

  async stop(): Promise<NativeCaptureStatus> {
    this.stopMetrics();
    this.stopPipeline();
    const server = this.server;
    this.server = null;
    if (server != null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.patch({
      listening: false,
      receiverConnected: false,
      ffmpegRunning: false,
      videoActive: false,
      stalled: false,
      bitrateMbps: 0,
      connectedAt: null,
      lastVideoDataAt: null,
      message: 'Receiver is stopped.',
    });
    return this.status();
  }

  async configureUsb(): Promise<NativeCaptureStatus> {
    if (!this.config.enabled) {
      throw new Error('Set QUEST_CAPTURE_ENABLED=true in .env first.');
    }
    try {
      const { stdout } = await execFileAsync('adb', ['get-state'], { timeout: 5000 });
      if (stdout.trim() !== 'device') {
        throw new Error('Quest is not connected or USB debugging is not approved.');
      }
      await execFileAsync(
        'adb',
        ['reverse', `tcp:${this.config.webPort}`, `tcp:${this.config.webPort}`],
        { timeout: 5000 },
      );
      await execFileAsync(
        'adb',
        ['reverse', `tcp:${this.config.inputPort}`, `tcp:${this.config.inputPort}`],
        { timeout: 5000 },
      );
      this.patch({
        adbConfigured: true,
        message: this.state.receiverConnected
          ? 'Quest video is reaching the Mac receiver.'
          : 'USB reverse configured; waiting for Quest video.',
        error: null,
      });
      return this.status();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patch({ adbConfigured: false, error: `ADB setup failed: ${message}` });
      throw new Error(`ADB setup failed: ${message}`);
    }
  }

  private accept(socket: Socket): void {
    this.connectionCount += 1;
    const reconnectCount = Math.max(0, this.connectionCount - 1);
    this.stopPipeline('A newer Quest connection replaced the previous connection.');
    this.socket = socket;
    this.connectedAtMs = Date.now();
    this.lastVideoDataAtMs = null;
    this.lastMetricAt = Date.now();
    this.lastMetricBytes = 0;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 2000);

    const udpUrl = `udp://127.0.0.1:${this.config.obsPort}?pkt_size=1316`;
    const ffmpeg = spawn(
      this.config.ffmpegBinary,
      [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-fflags',
        '+genpts',
        '-flags',
        'low_delay',
        '-use_wallclock_as_timestamps',
        '1',
        '-r',
        '30',
        '-f',
        'h264',
        '-i',
        'pipe:0',
        '-an',
        '-c:v',
        'copy',
        '-f',
        'mpegts',
        '-muxdelay',
        '0',
        '-muxpreload',
        '0',
        '-mpegts_flags',
        '+resend_headers',
        '-flush_packets',
        '1',
        udpUrl,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.ffmpeg = ffmpeg;
    ffmpeg.stdout.resume();
    this.patch({
      receiverConnected: true,
      ffmpegRunning: true,
      videoActive: false,
      stalled: false,
      bytesReceived: 0,
      bitrateMbps: 0,
      connectedAt: new Date(this.connectedAtMs).toISOString(),
      lastVideoDataAt: null,
      reconnectCount,
      message: 'Quest connected; waiting for encoded video.',
      error: null,
    });

    ffmpeg.on('error', (error) => {
      this.patch({
        ffmpegRunning: false,
        videoActive: false,
        message: 'FFmpeg relay failed.',
        error: `Unable to start FFmpeg: ${error.message}`,
      });
      socket.destroy();
    });
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk: string) => {
      const line = chunk.trim().split('\n').filter(Boolean).at(-1);
      if (line != null) console.warn(`[capture] FFmpeg: ${line}`);
    });
    ffmpeg.on('exit', (code, signal) => {
      if (this.ffmpeg !== ffmpeg) return;
      this.ffmpeg = null;
      if (!socket.destroyed) socket.destroy();
      this.patch({
        ffmpegRunning: false,
        videoActive: false,
        message: 'FFmpeg relay stopped; waiting for Quest to reconnect.',
        error:
          code === 0 || signal === 'SIGTERM'
            ? null
            : `FFmpeg stopped (${signal ?? `exit ${code}`}).`,
      });
    });

    socket.on('data', (chunk) => {
      this.lastVideoDataAtMs = Date.now();
      const bytesReceived = this.state.bytesReceived + chunk.length;
      this.state = { ...this.state,
        bytesReceived,
        lastVideoDataAt: new Date(this.lastVideoDataAtMs).toISOString(),
      };
      if (!ffmpeg.stdin.write(chunk)) socket.pause();
    });
    ffmpeg.stdin.on('drain', () => socket.resume());
    socket.on('error', (error) => this.patch({ error: `Quest TCP: ${error.message}` }));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connectedAtMs = null;
      this.lastVideoDataAtMs = null;
      if (this.ffmpeg === ffmpeg) {
        this.ffmpeg = null;
        ffmpeg.stdin.end();
        const forceStop = setTimeout(() => {
          if (ffmpeg.exitCode == null && ffmpeg.signalCode == null) ffmpeg.kill('SIGTERM');
        }, 1000);
        forceStop.unref();
      }
      this.patch({
        receiverConnected: false,
        ffmpegRunning: false,
        videoActive: false,
        stalled: false,
        bitrateMbps: 0,
        connectedAt: null,
        lastVideoDataAt: null,
        message: 'Quest disconnected; waiting for automatic reconnect.',
      });
    });
  }

  private startMetrics(): void {
    if (this.metricsTimer != null) return;
    this.metricsTimer = setInterval(() => this.updateMetrics(), 1000);
    this.metricsTimer.unref();
  }

  private stopMetrics(): void {
    if (this.metricsTimer != null) clearInterval(this.metricsTimer);
    this.metricsTimer = null;
  }

  private updateMetrics(): void {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - this.lastMetricAt);
    const deltaBytes = Math.max(0, this.state.bytesReceived - this.lastMetricBytes);
    const bitrateMbps = (deltaBytes * 8) / elapsedMs / 1000;
    this.lastMetricAt = now;
    this.lastMetricBytes = this.state.bytesReceived;

    const hasReceivedVideo = this.lastVideoDataAtMs != null;
    const stalled =
      this.state.receiverConnected &&
      hasReceivedVideo &&
      now - this.lastVideoDataAtMs! > this.config.stallThresholdMs;
    const videoActive =
      this.state.receiverConnected &&
      this.state.ffmpegRunning &&
      hasReceivedVideo &&
      !stalled;
    this.patch({
      bitrateMbps: Number(bitrateMbps.toFixed(2)),
      stalled,
      videoActive,
      message: stalled
        ? `Encoded video stalled for more than ${Math.round(this.config.stallThresholdMs / 1000)} seconds.`
        : videoActive
          ? 'Quest video is active and relaying to OBS.'
          : this.state.message,
      error: stalled
        ? 'No new H.264 bytes are reaching the receiver.'
        : this.state.error === 'No new H.264 bytes are reaching the receiver.'
          ? null
          : this.state.error,
    });
  }

  private stopPipeline(message?: string): void {
    const socket = this.socket;
    const ffmpeg = this.ffmpeg;
    this.socket = null;
    this.ffmpeg = null;
    this.connectedAtMs = null;
    this.lastVideoDataAtMs = null;
    if (socket != null) socket.destroy();
    if (ffmpeg != null) {
      ffmpeg.stdin.end();
      ffmpeg.kill('SIGTERM');
    }
    if (message != null) this.patch({ message });
  }

  private patch(values: Partial<NativeCaptureStatus>): void {
    this.state = { ...this.state, ...values };
    this.onChange(this.status());
  }
}

export function obsInputUrl(port: number): string {
  return `udp://127.0.0.1:${port}?fifo_size=1000000&overrun_nonfatal=1`;
}
