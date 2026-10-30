import { AssetType, defineAssets } from '@iwsdk/core';
import {
  createValidationCube,
} from './scene-assets/chatirl-phase-one.scene-asset.js';
import { createOrganicTabletop } from './scene-assets/chatirl-environment.scene-asset.js';
import { createFloatingTerrainIsland } from './scene-assets/chatirl-environment.scene-asset.js';
import { createPaintballBlaster } from './scene-assets/paintball-blaster.scene-asset.js';
import { createViewerAvatar } from './scene-assets/viewer-avatar.scene-asset.js';

export default defineAssets({
  'chatirl-tabletop': createOrganicTabletop(),
  'chatirl-floating-island': createFloatingTerrainIsland(),
  'chatirl-cube': createValidationCube(),
  'chatirl-paintball-blaster': createPaintballBlaster(),
  'viewer-avatar': createViewerAvatar(),
  'environment-base-large': {
    type: AssetType.GLTF,
    url: '/environment/Base_Large.gltf',
    priority: 'critical',
    name: 'Large Organic Terrain',
  },
  'environment-tree-blob-1': {
    type: AssetType.GLTF,
    url: '/environment/Tree_Blob_1.gltf',
    priority: 'critical',
  },
  'environment-tree-blob-2': {
    type: AssetType.GLTF,
    url: '/environment/Tree_Blob_2.gltf',
    priority: 'critical',
  },
  'environment-tree-spiral-1': {
    type: AssetType.GLTF,
    url: '/environment/Tree_Spiral_1.gltf',
    priority: 'critical',
  },
  'environment-bush-1': {
    type: AssetType.GLTF,
    url: '/environment/Bush_1.gltf',
    priority: 'critical',
  },
  'environment-bush-2': {
    type: AssetType.GLTF,
    url: '/environment/Bush_2.gltf',
    priority: 'critical',
  },
  'environment-grass-1': {
    type: AssetType.GLTF,
    url: '/environment/Grass_1.gltf',
    priority: 'critical',
  },
  'environment-grass-2': {
    type: AssetType.GLTF,
    url: '/environment/Grass_2.gltf',
    priority: 'critical',
  },
  'environment-plant-1': {
    type: AssetType.GLTF,
    url: '/environment/Plant_1.gltf',
    priority: 'critical',
  },
  'environment-plant-2': {
    type: AssetType.GLTF,
    url: '/environment/Plant_2.gltf',
    priority: 'critical',
  },
  'environment-rock-1': {
    type: AssetType.GLTF,
    url: '/environment/Rock_1.gltf',
    priority: 'critical',
  },
  'environment-rock-2': {
    type: AssetType.GLTF,
    url: '/environment/Rock_2.gltf',
    priority: 'critical',
  },
  'environment-rock-large-1': {
    type: AssetType.GLTF,
    url: '/environment/Rock_Large_1.gltf',
    priority: 'critical',
  },
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
