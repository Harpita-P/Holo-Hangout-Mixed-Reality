import { AssetType, defineAssets } from '@iwsdk/core';
import {
  createValidationCube,
  createValidationTabletop,
} from './scene-assets/chatirl-phase-one.scene-asset.js';
import { createViewerAvatar } from './scene-assets/viewer-avatar.scene-asset.js';

export default defineAssets({
  'chatirl-tabletop': createValidationTabletop(),
  'chatirl-cube': createValidationCube(),
  'viewer-avatar': createViewerAvatar(),
  'monster-chicken': {
    type: AssetType.GLTF,
    url: '/monsters/chicken.gltf',
    priority: 'critical',
    name: 'Chicken',
  },
  'monster-blue-mushroom': {
    type: AssetType.GLTF,
    url: '/monsters/blue-mushroom.gltf',
    priority: 'critical',
    name: 'Blue Mushroom',
  },
  'monster-pink-flying': {
    type: AssetType.GLTF,
    url: '/monsters/pink-flying.gltf',
    priority: 'critical',
    name: 'Pink Flying Monster',
  },
  'monster-green-sombrero': {
    type: AssetType.GLTF,
    url: '/monsters/green-sombrero.gltf',
    priority: 'critical',
    name: 'Green Sombrero Monster',
  },
  'monster-pink-blob': {
    type: AssetType.GLTF,
    url: '/monsters/pink-blob.gltf',
    priority: 'critical',
    name: 'Large Pink Blob',
  },
  'monster-bee': {
    type: AssetType.GLTF,
    url: '/monsters/bee.gltf',
    priority: 'critical',
    name: 'Flying Bee',
  },
});
