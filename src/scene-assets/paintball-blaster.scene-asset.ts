import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  createScenePrimitiveObject,
  type Object3D,
} from '@iwsdk/core';

const shell = new MeshStandardMaterial({ color: '#6236D8', roughness: 0.32, metalness: 0.18 });
const dark = new MeshStandardMaterial({ color: '#17243A', roughness: 0.48, metalness: 0.32 });
const accent = new MeshStandardMaterial({
  color: '#A78BFA',
  emissive: '#A78BFA',
  emissiveIntensity: 0.65,
  roughness: 0.28,
});
const glow = new MeshStandardMaterial({
  color: '#B794FF',
  emissive: '#B794FF',
  emissiveIntensity: 2.4,
  transparent: true,
  opacity: 0.95,
});

/** Toy blaster: 19 cm long, 15 cm tall, canonical forward is local -Z. */
export function createPaintballBlaster(): Object3D {
  const root = new Group();
  root.name = 'ChatIRL Paintball Blaster';

  const body = createScenePrimitiveObject(
    { geometry: { type: 'roundedBox', size: [0.09, 0.068, 0.115], radius: 0.02, segments: 4 } },
    shell,
  );
  body.name = 'Blaster Hull';
  body.position.set(0, 0.07, -0.016);

  const grip = createScenePrimitiveObject(
    { geometry: { type: 'roundedBox', size: [0.046, 0.098, 0.05], radius: 0.014, segments: 4 } },
    dark,
  );
  grip.name = 'Blaster Grip';
  grip.position.set(0, 0, 0.026);
  grip.rotation.x = -0.18;

  const barrel = new Mesh(new CylinderGeometry(0.024, 0.031, 0.095, 16), dark);
  barrel.name = 'Blaster Barrel';
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.074, -0.105);

  const muzzleRing = new Mesh(new TorusGeometry(0.028, 0.008, 8, 20), accent);
  muzzleRing.name = 'Muzzle Ring';
  muzzleRing.position.set(0, 0.074, -0.154);

  const energyCell = new Mesh(new SphereGeometry(0.026, 16, 10), accent);
  energyCell.name = 'Paint Cell';
  energyCell.scale.set(1, 0.75, 1);
  energyCell.position.set(0, 0.108, 0.028);

  const sight = createScenePrimitiveObject(
    { geometry: { type: 'roundedBox', size: [0.018, 0.024, 0.052], radius: 0.007, segments: 3 } },
    accent,
  );
  sight.name = 'Blaster Sight';
  sight.position.set(0, 0.12, -0.04);

  const muzzle = new Group();
  muzzle.name = 'Paintball Muzzle';
  muzzle.position.set(0, 0.074, -0.16);

  const flash = new Mesh(new SphereGeometry(0.02, 12, 8), glow);
  flash.name = 'Paintball Muzzle Flash';
  flash.scale.setScalar(0.001);
  flash.userData.iwsdkPreviewBounds = 'exclude';
  muzzle.add(flash);

  root.add(body, grip, barrel, muzzleRing, energyCell, sight, muzzle);
  root.traverse((child) => {
    if (child instanceof Mesh) child.castShadow = true;
  });
  return root;
}
