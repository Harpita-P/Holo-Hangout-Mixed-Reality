import { createComponent, Types } from '@iwsdk/core';

export const MonsterCategories = {
  Fallback: 'fallback',
  Big: 'big',
  Blob: 'blob',
  Flying: 'flying',
} as const;

export const MonsterStates = {
  Spawn: 'spawn',
  Autonomous: 'autonomous',
  Command: 'command',
  Held: 'held',
  Leaving: 'leaving',
} as const;

export const MonsterAvatar = createComponent('MonsterAvatar', {
  monsterType: { type: Types.String, default: 'procedural-fallback' },
  category: {
    type: Types.Enum,
    default: MonsterCategories.Fallback,
    enum: MonsterCategories,
  },
  state: {
    type: Types.Enum,
    default: MonsterStates.Autonomous,
    enum: MonsterStates,
  },
  activeClip: { type: Types.String, default: '' },
});
