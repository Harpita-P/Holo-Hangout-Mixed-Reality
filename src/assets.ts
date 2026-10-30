import { defineAssets } from '@iwsdk/core';
import {
  createValidationCube,
  createValidationTabletop,
} from './scene-assets/chatirl-phase-one.scene-asset.js';

export default defineAssets({
  'chatirl-tabletop': createValidationTabletop(),
  'chatirl-cube': createValidationCube(),
});
