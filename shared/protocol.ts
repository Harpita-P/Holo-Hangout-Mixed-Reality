export const AvatarBehaviors = {
  Idle: 'idle',
  Run: 'run',
  Wave: 'wave',
  Dance: 'dance',
  Jump: 'jump',
  Leaving: 'leaving',
} as const;

export type AvatarBehavior =
  (typeof AvatarBehaviors)[keyof typeof AvatarBehaviors];

export interface ParticipantSnapshot {
  userId: string;
  displayName: string;
  colorHex: string;
  slot: number;
  behavior: AvatarBehavior;
  actionSequence: number;
  targetX: number;
  targetZ: number;
}

export type ServerMessage =
  | {
      type: 'session.snapshot';
      participants: ParticipantSnapshot[];
      acceptingJoins: boolean;
    }
  | { type: 'avatar.join'; participant: ParticipantSnapshot }
  | {
      type: 'avatar.action';
      userId: string;
      behavior: AvatarBehavior;
      actionSequence: number;
      targetX: number;
      targetZ: number;
    }
  | { type: 'avatar.leave'; userId: string; deadlineMs: number }
  | { type: 'avatar.removed'; userId: string }
  | {
      type: 'server.status';
      twitchConnected: boolean;
      broadcasterLogin: string | null;
    };

export type ClientMessage =
  | { type: 'client.ready' }
  | { type: 'avatar.held'; userId: string; held: boolean };

export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'client.ready') {
    return true;
  }
  return (
    candidate.type === 'avatar.held' &&
    typeof candidate.userId === 'string' &&
    typeof candidate.held === 'boolean'
  );
}
