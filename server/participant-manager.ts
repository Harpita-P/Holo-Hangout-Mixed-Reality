import {
  AvatarBehaviors,
  type ParticipantSnapshot,
  type CommunityLeaderboardEntry,
  type ServerMessage,
} from '../shared/protocol.js';
import {
  commandForMonster,
  monsterForSlot,
  nextMonsterAfter,
  supportedCommands,
  type MonsterType,
  type MonsterCommandSpec,
} from '../shared/monsters.js';

export interface ChatMessage {
  userId: string;
  displayName: string;
  text: string;
}

interface ManagedParticipant extends ParticipantSnapshot {
  actionTimer: NodeJS.Timeout | null;
  leaveTimer: NodeJS.Timeout | null;
}

export interface ParticipantManagerOptions {
  maxParticipants?: number;
  actionCooldownMs?: number;
  chatCooldownMs?: number;
  scoreCooldownMs?: number;
  leaveDeadlineMs?: number;
  emit: (message: ServerMessage) => void;
}

export class ParticipantManager {
  private readonly participants = new Map<string, ManagedParticipant>();
  private readonly cooldowns = new Map<string, number>();
  private readonly chatCooldowns = new Map<string, number>();
  private readonly lastMonsterByUser = new Map<string, MonsterType>();
  private readonly scores = new Map<string, number>();
  private readonly scoreCooldowns = new Map<string, number>();
  private readonly maxParticipants: number;
  private readonly actionCooldownMs: number;
  private readonly chatCooldownMs: number;
  private readonly scoreCooldownMs: number;
  private readonly leaveDeadlineMs: number;
  private acceptingJoins = true;

  constructor(private readonly options: ParticipantManagerOptions) {
    this.maxParticipants = options.maxParticipants ?? 10;
    this.actionCooldownMs = options.actionCooldownMs ?? 750;
    this.chatCooldownMs = options.chatCooldownMs ?? 2000;
    this.scoreCooldownMs = options.scoreCooldownMs ?? 1000;
    this.leaveDeadlineMs = options.leaveDeadlineMs ?? 1200;
  }

  snapshot(): ParticipantSnapshot[] {
    return [...this.participants.values()]
      .sort((left, right) => left.slot - right.slot)
      .map(({ actionTimer: _actionTimer, leaveTimer: _leaveTimer, ...value }) =>
        value,
      );
  }

  snapshotMessage(): Extract<ServerMessage, { type: 'session.snapshot' }> {
    return {
      type: 'session.snapshot',
      participants: this.snapshot(),
      acceptingJoins: this.acceptingJoins,
    };
  }

  leaderboardMessage(): Extract<ServerMessage, { type: 'community.leaderboard' }> {
    const entries: CommunityLeaderboardEntry[] = [...this.participants.values()]
      .filter(({ behavior }) => behavior !== AvatarBehaviors.Leaving)
      .map(({ userId, displayName, slot }) => ({
        userId,
        displayName,
        score: this.scores.get(userId) ?? 0,
        slot,
      }))
      .sort((left, right) => right.score - left.score || left.slot - right.slot)
      .slice(0, 3)
      .map(({ slot: _slot, ...entry }) => entry);
    return { type: 'community.leaderboard', entries };
  }

  handleChat(message: ChatMessage): boolean {
    const text = message.text.trim();
    if (!text) return false;
    const command = text.split(/\s+/u)[0]?.toLowerCase();
    if (command === '!join') {
      return this.join(message.userId, message.displayName);
    }
    if (command === '!leave') {
      return this.leave(message.userId);
    }
    const participant = this.participants.get(message.userId);
    if (text.startsWith('!')) {
      const action =
        participant == null
          ? null
          : commandForMonster(participant.monsterType, command);
      return action == null ? false : this.act(message.userId, action);
    }
    if (participant == null || participant.behavior === AvatarBehaviors.Leaving) {
      return false;
    }
    const now = Date.now();
    if ((this.chatCooldowns.get(message.userId) ?? 0) > now) return false;
    const safeText = sanitizeChatText(text);
    if (!safeText) return false;
    this.chatCooldowns.set(message.userId, now + this.chatCooldownMs);
    this.options.emit({ type: 'avatar.chat', userId: message.userId, text: safeText });
    this.awardScore(message.userId, 1, now);
    return true;
  }

  setAcceptingJoins(acceptingJoins: boolean): void {
    this.acceptingJoins = acceptingJoins;
    this.options.emit(this.snapshotMessage());
  }

  clear(): void {
    for (const participant of this.participants.values()) {
      this.clearTimers(participant);
      this.options.emit({
        type: 'avatar.leave',
        userId: participant.userId,
        deadlineMs: 0,
      });
      this.options.emit({ type: 'avatar.removed', userId: participant.userId });
    }
    this.participants.clear();
    this.cooldowns.clear();
    this.chatCooldowns.clear();
    this.scores.clear();
    this.scoreCooldowns.clear();
    this.options.emit(this.leaderboardMessage());
  }

  private join(userId: string, displayName: string): boolean {
    const existing = this.participants.get(userId);
    if (existing != null) {
      if (existing.behavior === AvatarBehaviors.Leaving) return false;
      this.options.emit({ type: 'avatar.join', participant: this.public(existing) });
      this.options.emit(this.leaderboardMessage());
      return true;
    }
    if (!this.acceptingJoins) {
      return false;
    }
    const slot = this.nextOpenSlot();
    if (slot < 0) {
      return false;
    }
    const lastMonster = this.lastMonsterByUser.get(userId);
    const monster =
      lastMonster == null ? monsterForSlot(slot) : nextMonsterAfter(lastMonster);
    this.lastMonsterByUser.set(userId, monster.type);
    const participant: ManagedParticipant = {
      userId,
      displayName: sanitizeDisplayName(displayName),
      colorHex: colorForUser(userId),
      slot,
      monsterType: monster.type,
      monsterCategory: monster.category,
      monsterName: monster.name,
      supportedCommands: supportedCommands(monster.type),
      behavior: AvatarBehaviors.Idle,
      actionSequence: 0,
      targetX: 0,
      targetZ: 0,
      actionTimer: null,
      leaveTimer: null,
    };
    this.participants.set(userId, participant);
    this.scores.set(userId, 0);
    this.options.emit({ type: 'avatar.join', participant: this.public(participant) });
    this.options.emit(this.leaderboardMessage());
    return true;
  }

  private act(userId: string, action: MonsterCommandSpec): boolean {
    const participant = this.participants.get(userId);
    if (participant == null || participant.behavior === AvatarBehaviors.Leaving) {
      return false;
    }
    const now = Date.now();
    if ((this.cooldowns.get(userId) ?? 0) > now) {
      return false;
    }
    this.cooldowns.set(userId, now + this.actionCooldownMs);
    if (participant.actionTimer != null) {
      clearTimeout(participant.actionTimer);
    }
    participant.behavior = action.behavior;
    participant.actionSequence += 1;
    if (action.moves) {
      const target = runTarget(userId, participant.actionSequence);
      participant.targetX = target.x;
      participant.targetZ = target.z;
    }
    this.options.emit({
      type: 'avatar.action',
      userId,
      behavior: action.behavior,
      actionSequence: participant.actionSequence,
      targetX: participant.targetX,
      targetZ: participant.targetZ,
    });
    this.awardScore(userId, 2, now);
    participant.actionTimer = setTimeout(() => {
      if (participant.behavior !== AvatarBehaviors.Leaving) {
        participant.behavior = AvatarBehaviors.Idle;
        participant.actionSequence += 1;
        this.options.emit({
          type: 'avatar.action',
          userId,
          behavior: AvatarBehaviors.Idle,
          actionSequence: participant.actionSequence,
          targetX: participant.targetX,
          targetZ: participant.targetZ,
        });
      }
      participant.actionTimer = null;
    }, action.durationMs);
    participant.actionTimer.unref();
    return true;
  }

  private leave(userId: string): boolean {
    const participant = this.participants.get(userId);
    if (participant == null || participant.behavior === AvatarBehaviors.Leaving) {
      return false;
    }
    if (participant.actionTimer != null) {
      clearTimeout(participant.actionTimer);
      participant.actionTimer = null;
    }
    participant.behavior = AvatarBehaviors.Leaving;
    participant.actionSequence += 1;
    this.scores.delete(userId);
    this.scoreCooldowns.delete(userId);
    this.options.emit(this.leaderboardMessage());
    this.options.emit({
      type: 'avatar.leave',
      userId,
      deadlineMs: this.leaveDeadlineMs,
    });
    participant.leaveTimer = setTimeout(() => {
      this.participants.delete(userId);
      this.cooldowns.delete(userId);
      this.chatCooldowns.delete(userId);
      this.scores.delete(userId);
      this.scoreCooldowns.delete(userId);
      this.options.emit({ type: 'avatar.removed', userId });
    }, this.leaveDeadlineMs);
    participant.leaveTimer.unref();
    return true;
  }

  private nextOpenSlot(): number {
    const used = new Set([...this.participants.values()].map(({ slot }) => slot));
    for (let slot = 0; slot < this.maxParticipants; slot += 1) {
      if (!used.has(slot)) {
        return slot;
      }
    }
    return -1;
  }

  private awardScore(userId: string, points: number, now: number): void {
    const participant = this.participants.get(userId);
    if (participant == null || participant.behavior === AvatarBehaviors.Leaving) return;
    if ((this.scoreCooldowns.get(userId) ?? 0) > now) return;
    this.scoreCooldowns.set(userId, now + this.scoreCooldownMs);
    this.scores.set(userId, (this.scores.get(userId) ?? 0) + points);
    this.options.emit(this.leaderboardMessage());
  }

  private public(participant: ManagedParticipant): ParticipantSnapshot {
    const { actionTimer: _actionTimer, leaveTimer: _leaveTimer, ...value } =
      participant;
    return value;
  }

  private clearTimers(participant: ManagedParticipant): void {
    if (participant.actionTimer != null) clearTimeout(participant.actionTimer);
    if (participant.leaveTimer != null) clearTimeout(participant.leaveTimer);
  }
}

function sanitizeDisplayName(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/gu, '').trim().slice(0, 25) || 'viewer';
}

function sanitizeChatText(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...normalized].slice(0, 100).join('');
}

function runTarget(userId: string, sequence: number): { x: number; z: number } {
  const seed = hash(`${userId}:${sequence}`);
  return {
    x: ((seed & 0xffff) / 0xffff - 0.5) * 0.46,
    z: (((seed >>> 16) & 0xffff) / 0xffff - 0.5) * 0.28,
  };
}

function colorForUser(userId: string): string {
  const hue = hash(userId) % 360;
  const saturation = 68;
  const lightness = 58;
  const chroma = (1 - Math.abs((2 * lightness) / 100 - 1)) * (saturation / 100);
  const section = hue / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] =
    section < 1
      ? [chroma, secondary, 0]
      : section < 2
        ? [secondary, chroma, 0]
        : section < 3
          ? [0, chroma, secondary]
          : section < 4
            ? [0, secondary, chroma]
            : section < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const match = lightness / 100 - chroma / 2;
  return `#${[red, green, blue]
    .map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}
