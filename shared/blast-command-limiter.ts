export class BlastCommandLimiter {
  private readonly perViewerReadyAt = new Map<string, number>();
  private readonly recentGlobalShots: number[] = [];

  constructor(
    private readonly perViewerCooldownMs = 5000,
    private readonly globalWindowMs = 1000,
    private readonly globalLimit = 4,
  ) {}

  accept(userId: string, now: number): boolean {
    while (
      this.recentGlobalShots.length > 0 &&
      this.recentGlobalShots[0]! <= now - this.globalWindowMs
    ) {
      this.recentGlobalShots.shift();
    }
    if ((this.perViewerReadyAt.get(userId) ?? 0) > now) return false;
    if (this.recentGlobalShots.length >= this.globalLimit) return false;
    this.perViewerReadyAt.set(userId, now + this.perViewerCooldownMs);
    this.recentGlobalShots.push(now);
    return true;
  }

  remove(userId: string): void {
    this.perViewerReadyAt.delete(userId);
  }

  clear(): void {
    this.perViewerReadyAt.clear();
    this.recentGlobalShots.length = 0;
  }
}
