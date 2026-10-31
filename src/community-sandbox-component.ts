import { createComponent, Types } from '@iwsdk/core';

export const CommunitySandboxCreation = createComponent('CommunitySandboxCreation', {
  slot: { type: Types.Int8, default: 0 },
  creationId: { type: Types.String, default: '' },
});
