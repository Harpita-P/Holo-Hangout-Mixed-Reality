import { createComponent, Types } from '@iwsdk/core';

export const FloatingTerrain = createComponent('FloatingTerrain', {
  amplitude: { type: Types.Float32, default: 0.01 },
  speed: { type: Types.Float32, default: 0.8 },
  phase: { type: Types.Float32, default: 0 },
});
