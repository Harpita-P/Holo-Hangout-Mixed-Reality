interface PendingHold {
  startedAt: number;
  triggered: boolean;
}

export class ShoutoutTracker {
  private readonly pending = new Map<string, PendingHold>();
  private readonly cooldowns = new Map<string, number>();

  constructor(
    private readonly holdSeconds = 4,
    private readonly cooldownSeconds = 20,
  ) {}

  begin(userId: string, isBot: boolean, time: number): boolean {
    if (!userId || isBot || this.pending.has(userId)) return false;
    if ((this.cooldowns.get(userId) ?? 0) > time) return false;
    this.pending.set(userId, { startedAt: time, triggered: false });
    return true;
  }

  release(userId: string): void {
    this.pending.delete(userId);
  }

  cancel(userId: string): void {
    this.pending.delete(userId);
  }

  update(time: number): string[] {
    const triggered: string[] = [];
    for (const [userId, hold] of this.pending) {
      if (hold.triggered || time - hold.startedAt < this.holdSeconds) continue;
      hold.triggered = true;
      this.cooldowns.set(userId, time + this.cooldownSeconds);
      triggered.push(userId);
    }
    return triggered;
  }

  clear(): void {
    this.pending.clear();
    this.cooldowns.clear();
  }
}
