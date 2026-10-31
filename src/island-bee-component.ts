import { createComponent, Types } from '@iwsdk/core';

export const IslandBee = createComponent('IslandBee', {
  radius: { type: Types.Float32, default: 0.11 },
  hoverHeight: { type: Types.Float32, default: 0.23 },
  phase: { type: Types.Float32, default: 0 },
});
