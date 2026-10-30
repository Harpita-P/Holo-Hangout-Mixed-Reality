import { AvatarBehaviors, type AvatarBehavior } from './protocol.js';

export const MonsterCategories = {
  Big: 'big',
  Blob: 'blob',
  Flying: 'flying',
} as const;

export type MonsterCategory =
  (typeof MonsterCategories)[keyof typeof MonsterCategories];

export const MonsterTypes = {
  Chicken: 'chicken',
  BlueMushroom: 'blue-mushroom',
  PinkFlying: 'pink-flying',
  GreenSombrero: 'green-sombrero',
  PinkBlob: 'pink-blob',
  Bee: 'bee',
} as const;

export type MonsterType = (typeof MonsterTypes)[keyof typeof MonsterTypes];

export interface MonsterDefinition {
  type: MonsterType;
  name: string;
  category: MonsterCategory;
  assetId: string;
  targetHeight: number;
}

export interface MonsterCommandSpec {
  behavior: AvatarBehavior;
  clips: readonly string[];
  durationMs: number;
  moves: boolean;
}

export const MONSTER_ROSTER: readonly MonsterDefinition[] = [
  { type: MonsterTypes.Chicken, name: 'Chicken', category: MonsterCategories.Blob, assetId: 'monster-chicken', targetHeight: 0.105 },
  { type: MonsterTypes.BlueMushroom, name: 'Blue Mushroom', category: MonsterCategories.Big, assetId: 'monster-blue-mushroom', targetHeight: 0.17 },
  { type: MonsterTypes.PinkFlying, name: 'Pink Flying Monster', category: MonsterCategories.Flying, assetId: 'monster-pink-flying', targetHeight: 0.12 },
  { type: MonsterTypes.GreenSombrero, name: 'Green Sombrero Monster', category: MonsterCategories.Big, assetId: 'monster-green-sombrero', targetHeight: 0.17 },
  { type: MonsterTypes.PinkBlob, name: 'Large Pink Blob', category: MonsterCategories.Blob, assetId: 'monster-pink-blob', targetHeight: 0.105 },
  { type: MonsterTypes.Bee, name: 'Flying Bee', category: MonsterCategories.Flying, assetId: 'monster-bee', targetHeight: 0.105 },
] as const;

export const MONSTER_COMMANDS: Readonly<
  Record<MonsterCategory, Readonly<Record<string, MonsterCommandSpec>>>
> = {
  big: {
    '!run': { behavior: AvatarBehaviors.Run, clips: ['Run'], durationMs: 2400, moves: true },
    '!jump': { behavior: AvatarBehaviors.Jump, clips: ['Jump', 'Jump_Idle', 'Jump_Land'], durationMs: 1400, moves: false },
    '!wave': { behavior: AvatarBehaviors.Wave, clips: ['Wave'], durationMs: 1800, moves: false },
    '!duck': { behavior: AvatarBehaviors.Duck, clips: ['Duck'], durationMs: 1800, moves: false },
    '!punch': { behavior: AvatarBehaviors.Punch, clips: ['Punch'], durationMs: 1100, moves: false },
    '!yes': { behavior: AvatarBehaviors.Yes, clips: ['Yes'], durationMs: 1800, moves: false },
    '!no': { behavior: AvatarBehaviors.No, clips: ['No'], durationMs: 1800, moves: false },
  },
  blob: {
    '!dance': { behavior: AvatarBehaviors.Dance, clips: ['Dance'], durationMs: 900, moves: false },
    '!jump': { behavior: AvatarBehaviors.Jump, clips: ['Jump'], durationMs: 700, moves: false },
    '!bite': { behavior: AvatarBehaviors.Bite, clips: ['Bite_Front'], durationMs: 650, moves: false },
    '!walk': { behavior: AvatarBehaviors.Walk, clips: ['Walk'], durationMs: 2200, moves: true },
    '!yes': { behavior: AvatarBehaviors.Yes, clips: ['Yes'], durationMs: 1200, moves: false },
    '!no': { behavior: AvatarBehaviors.No, clips: ['No'], durationMs: 1200, moves: false },
  },
  flying: {
    '!fly': { behavior: AvatarBehaviors.Fly, clips: ['Fast_Flying'], durationMs: 1900, moves: true },
    '!headbutt': { behavior: AvatarBehaviors.Headbutt, clips: ['Headbutt'], durationMs: 1400, moves: false },
    '!punch': { behavior: AvatarBehaviors.Punch, clips: ['Punch'], durationMs: 1400, moves: false },
    '!yes': { behavior: AvatarBehaviors.Yes, clips: ['Yes'], durationMs: 1400, moves: false },
    '!no': { behavior: AvatarBehaviors.No, clips: ['No'], durationMs: 1400, moves: false },
  },
};

export const MONSTER_AUTONOMY_CLIPS: Readonly<
  Record<MonsterCategory, { idle: string; move: string }>
> = {
  big: { idle: 'Idle', move: 'Walk' },
  blob: { idle: 'Idle', move: 'Walk' },
  flying: { idle: 'Flying_Idle', move: 'Fast_Flying' },
};

export function monsterForSlot(slot: number): MonsterDefinition {
  return MONSTER_ROSTER[((slot % MONSTER_ROSTER.length) + MONSTER_ROSTER.length) % MONSTER_ROSTER.length];
}

export function nextMonsterAfter(type: MonsterType): MonsterDefinition {
  const index = MONSTER_ROSTER.findIndex((monster) => monster.type === type);
  return MONSTER_ROSTER[(index + 1) % MONSTER_ROSTER.length];
}

export function monsterByType(type: MonsterType): MonsterDefinition {
  return MONSTER_ROSTER.find((monster) => monster.type === type) ?? MONSTER_ROSTER[0];
}

export function commandForMonster(
  type: MonsterType,
  command: string | undefined,
): MonsterCommandSpec | null {
  if (command == null) return null;
  return MONSTER_COMMANDS[monsterByType(type).category][command] ?? null;
}

export function commandForBehavior(
  category: MonsterCategory,
  behavior: AvatarBehavior,
): MonsterCommandSpec | null {
  return (
    Object.values(MONSTER_COMMANDS[category]).find(
      (command) => command.behavior === behavior,
    ) ?? null
  );
}

export function supportedCommands(type: MonsterType): string[] {
  const actionCommands = Object.keys(MONSTER_COMMANDS[monsterByType(type).category]);
  return [
    '!join',
    ...actionCommands,
    '!support',
    '!like',
    '!fire',
    '!leave',
  ];
}
