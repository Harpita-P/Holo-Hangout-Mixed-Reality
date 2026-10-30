import { createComponent, Types } from '@iwsdk/core';
import { AvatarBehaviors } from '../shared/protocol.js';

export const ViewerAvatar = createComponent('ViewerAvatar', {
  userId: { type: Types.String, default: '' },
  displayName: { type: Types.String, default: '' },
  colorHex: { type: Types.String, default: '#2ED7C4' },
  behavior: {
    type: Types.Enum,
    default: AvatarBehaviors.Idle,
    enum: AvatarBehaviors,
  },
  actionSequence: { type: Types.Int32, default: 0 },
  targetX: { type: Types.Float32, default: 0 },
  targetZ: { type: Types.Float32, default: 0 },
  paintballHitSequence: { type: Types.Int32, default: 0 },
});
