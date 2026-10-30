import { createComponent, Types } from '@iwsdk/core';

export const PaintballBlaster = createComponent('PaintballBlaster', {
  shotsFired: { type: Types.Int32, default: 0 },
  hits: { type: Types.Int32, default: 0 },
});
