import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  type Object3D,
} from '@iwsdk/core';

const tintMaterial = new MeshStandardMaterial({
  color: '#2ED7C4',
  roughness: 0.46,
  metalness: 0.02,
});
tintMaterial.name = 'AvatarTint';

const darkMaterial = new MeshStandardMaterial({
  color: '#102A31',
  roughness: 0.58,
  metalness: 0,
});
darkMaterial.name = 'AvatarDark';

function capsule(
  name: string,
  radius: number,
  length: number,
  material: MeshStandardMaterial,
): Group {
  const root = new Group();
  root.name = name;
  const body = new Mesh(
    new CylinderGeometry(radius, radius, length, 10, 1, false),
    material,
  );
  body.name = `${name} Body`;
  const top = new Mesh(new SphereGeometry(radius, 10, 8), material);
  top.name = `${name} Top`;
  top.position.y = length / 2;
  const bottom = top.clone();
  bottom.name = `${name} Bottom`;
  bottom.position.y = -length / 2;
  for (const mesh of [body, top, bottom]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  root.add(body, top, bottom);
  return root;
}

function arm(name: string, x: number): Group {
  const pivot = new Group();
  pivot.name = name;
  pivot.position.set(x, 0.112, 0);
  const limb = capsule(`${name} Mesh`, 0.009, 0.045, tintMaterial);
  limb.position.y = -0.03;
  pivot.add(limb);
  return pivot;
}

/**
 * A lightweight 18 cm-tall character. Origin is at foot contact, +Y is up,
 * and the face looks toward +Z (the default streamer-facing table direction).
 */
export function createViewerAvatar(): Object3D {
  const root = new Group();
  root.name = 'Viewer Avatar';

  const torso = capsule('Torso', 0.025, 0.042, tintMaterial);
  torso.position.y = 0.092;

  const head = new Mesh(new SphereGeometry(0.033, 16, 12), tintMaterial);
  head.name = 'Head';
  head.position.y = 0.155;
  head.castShadow = true;

  const leftEye = new Mesh(new SphereGeometry(0.0042, 8, 6), darkMaterial);
  leftEye.name = 'Left Eye';
  leftEye.position.set(-0.012, 0.159, 0.0305);
  const rightEye = leftEye.clone();
  rightEye.name = 'Right Eye';
  rightEye.position.x = 0.012;

  const leftLeg = capsule('Left Leg', 0.01, 0.035, darkMaterial);
  leftLeg.position.set(-0.015, 0.0275, 0);
  const rightLeg = capsule('Right Leg', 0.01, 0.035, darkMaterial);
  rightLeg.position.set(0.015, 0.0275, 0);

  root.add(
    torso,
    head,
    leftEye,
    rightEye,
    leftLeg,
    rightLeg,
    arm('Left Arm', -0.035),
    arm('Right Arm', 0.035),
  );
  return root;
}
