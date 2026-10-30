import {
  createSceneMaterial,
  createScenePrimitiveObject,
  Group,
  type Object3D,
} from '@iwsdk/core';

const tabletopBaseMaterial = createSceneMaterial({
  id: 'chatirl-tabletop-base',
  model: 'physical',
  baseColor: '#12323B',
  roughness: 0.42,
  metalness: 0.05,
  clearcoat: 0.45,
  clearcoatRoughness: 0.2,
});

const tabletopSurfaceMaterial = createSceneMaterial({
  id: 'chatirl-tabletop-surface',
  model: 'physical',
  baseColor: '#2ED7C4',
  roughness: 0.32,
  metalness: 0,
  clearcoat: 0.65,
  clearcoatRoughness: 0.16,
});

const cubeMaterial = createSceneMaterial({
  id: 'chatirl-validation-cube',
  model: 'physical',
  baseColor: '#FF7849',
  emissive: '#351006',
  emissiveIntensity: 0.35,
  roughness: 0.28,
  metalness: 0.03,
  clearcoat: 0.75,
  clearcoatRoughness: 0.12,
});

/** A 62 x 44 cm placement surface with its origin at bottom-center. */
export function createValidationTabletop(): Object3D {
  const root = new Group();
  root.name = 'ChatIRL Validation Tabletop';

  const base = createScenePrimitiveObject(
    {
      geometry: {
        type: 'roundedBox',
        size: [0.62, 0.032, 0.44],
        radius: 0.028,
        segments: 4,
      },
    },
    tabletopBaseMaterial,
  );
  base.name = 'Tabletop Base';
  base.position.y = 0.016;

  const surface = createScenePrimitiveObject(
    {
      geometry: {
        type: 'roundedBox',
        size: [0.57, 0.012, 0.39],
        radius: 0.02,
        segments: 4,
      },
    },
    tabletopSurfaceMaterial,
  );
  surface.name = 'Placement Surface';
  surface.position.y = 0.038;

  root.add(base, surface);
  return root;
}

/** A high-contrast 10.5 cm cube with its origin at its center. */
export function createValidationCube(): Object3D {
  const cube = createScenePrimitiveObject(
    {
      geometry: {
        type: 'roundedBox',
        size: [0.105, 0.105, 0.105],
        radius: 0.014,
        segments: 5,
      },
    },
    cubeMaterial,
  );
  cube.name = 'ChatIRL Grab Cube';
  return cube;
}
