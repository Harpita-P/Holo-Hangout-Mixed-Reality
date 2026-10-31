import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type MomentState = 'idle' | 'creating' | 'ready' | 'failed' | 'unavailable';

export interface VerifiedClip {
  id: string;
  url: string;
  title: string;
  createdAt: string;
}

export interface HangoutMomentsStatus {
  autoClipEnabled: boolean;
  state: MomentState;
  message: string;
  recent: VerifiedClip[];
}

export interface TwitchClipGateway {
  clipsAuthorized(): boolean;
  isBroadcasterLive(): Promise<boolean>;
  createClip(title: string, duration: number): Promise<{ id: string }>;
  getClip(id: string): Promise<VerifiedClip | null>;
}

interface StoredMoments {
  autoClipEnabled: boolean;
  recent: VerifiedClip[];
}

const AUTO_COOLDOWN_MS = 5 * 60_000;
const MAX_HISTORY = 8;

export class HangoutMomentsService {
  private autoClipEnabled = false;
  private state: MomentState = 'idle';
  private message = 'Ready when Twitch is live.';
  private recent: VerifiedClip[] = [];
  private readonly processedRuns = new Set<string>();
  private lastAutomaticAt = Number.NEGATIVE_INFINITY;
  private creating = false;

  constructor(
    private readonly gateway: TwitchClipGateway | null,
    private readonly storagePath: string,
    private readonly onChange: (status: HangoutMomentsStatus) => void,
    private readonly onVerified: (clip: VerifiedClip) => void,
    private readonly now: () => number = Date.now,
    private readonly pollDelayMs = 2000,
    private readonly maxPolls = 31,
  ) {}

  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.storagePath, 'utf8')) as StoredMoments;
      this.autoClipEnabled = stored.autoClipEnabled === true;
      this.recent = Array.isArray(stored.recent) ? stored.recent.slice(0, MAX_HISTORY) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Hangout Moments load failed:', error);
    }
    this.publish();
  }

  status(): HangoutMomentsStatus {
    const missingPermission = this.gateway == null || !this.gateway.clipsAuthorized();
    return {
      autoClipEnabled: this.autoClipEnabled,
      state: this.state === 'idle' && missingPermission ? 'unavailable' : this.state,
      message: this.state === 'idle' && missingPermission
        ? 'Reconnect Twitch to grant the clips:edit permission.'
        : this.message,
      recent: [...this.recent],
    };
  }

  async setAutoClipEnabled(enabled: boolean): Promise<HangoutMomentsStatus> {
    this.autoClipEnabled = enabled;
    this.state = 'idle';
    this.message = enabled ? 'Automatic challenge clips enabled.' : 'Automatic challenge clips disabled.';
    await this.persist();
    this.publish();
    return this.status();
  }

  async completeChallenge(runId: string): Promise<HangoutMomentsStatus> {
    if (!runId || this.processedRuns.has(runId)) return this.status();
    this.processedRuns.add(runId);
    if (this.processedRuns.size > 100) {
      const oldest = this.processedRuns.values().next().value as string | undefined;
      if (oldest != null) this.processedRuns.delete(oldest);
    }
    if (!this.autoClipEnabled) return this.status();
    const now = this.now();
    if (now - this.lastAutomaticAt < AUTO_COOLDOWN_MS) {
      this.state = 'unavailable';
      this.message = 'Automatic clip skipped during the 5-minute cooldown.';
      this.publish();
      return this.status();
    }
    return this.createMoment('HoloHangout Moment — Blaster Challenge!', true);
  }

  async createManualMoment(): Promise<HangoutMomentsStatus> {
    return this.createMoment('HoloHangout Moment!', false);
  }

  private async createMoment(title: string, automatic: boolean): Promise<HangoutMomentsStatus> {
    if (this.creating) {
      this.state = 'unavailable';
      this.message = 'A Hangout Moment is already being created.';
      this.publish();
      return this.status();
    }
    if (this.gateway == null || !this.gateway.clipsAuthorized()) {
      this.state = 'unavailable';
      this.message = 'Reconnect Twitch to grant the clips:edit permission.';
      this.publish();
      return this.status();
    }
    this.creating = true;
    this.state = 'creating';
    this.message = 'Creating clip…';
    this.publish();
    try {
      if (!(await this.gateway.isBroadcasterLive())) {
        this.state = 'unavailable';
        this.message = 'The broadcaster is offline. Start the Twitch stream first.';
        return this.status();
      }
      if (automatic) this.lastAutomaticAt = this.now();
      const requested = await this.gateway.createClip(title, 60);
      for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
        if (attempt > 0) await delay(this.pollDelayMs);
        const verified = await this.gateway.getClip(requested.id);
        if (verified == null) continue;
        this.recent = [verified, ...this.recent.filter(({ id }) => id !== verified.id)].slice(0, MAX_HISTORY);
        this.state = 'ready';
        this.message = 'Moment ready!';
        await this.persist();
        this.onVerified(verified);
        return this.status();
      }
      this.state = 'failed';
      this.message = 'Twitch accepted the request but the clip was not available within 60 seconds.';
      return this.status();
    } catch (error) {
      this.state = 'failed';
      this.message = error instanceof Error ? error.message : String(error);
      return this.status();
    } finally {
      this.creating = false;
      this.publish();
    }
  }

  private publish(): void {
    this.onChange(this.status());
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.storagePath), { recursive: true });
    await writeFile(
      this.storagePath,
      JSON.stringify({ autoClipEnabled: this.autoClipEnabled, recent: this.recent }),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
