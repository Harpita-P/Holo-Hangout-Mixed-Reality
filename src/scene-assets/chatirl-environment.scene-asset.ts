import {
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  type Object3D,
} from '@iwsdk/core';

const grass = new MeshStandardMaterial({
  color: '#438F43',
  roughness: 0.82,
  metalness: 0,
});
const earth = new MeshStandardMaterial({
  color: '#244F2C',
  roughness: 0.92,
  metalness: 0,
});
const lightGrass = new MeshStandardMaterial({
  color: '#65A94B',
  roughness: 0.86,
  metalness: 0,
});
const coolGrass = new MeshStandardMaterial({
  color: '#328654',
  roughness: 0.86,
  metalness: 0,
});
const sunnyGrass = new MeshStandardMaterial({
  color: '#78B84F',
  roughness: 0.88,
  metalness: 0,
});
const deepGrass = new MeshStandardMaterial({
  color: '#2D783D',
  roughness: 0.9,
  metalness: 0,
});
const floatingStone = new MeshStandardMaterial({
  color: '#6D5946',
  roughness: 0.96,
  metalness: 0,
  flatShading: true,
});

function terrainOutline(): Shape {
  const shape = new Shape();
  shape.moveTo(-0.84, -0.38);
  shape.bezierCurveTo(-0.7, -0.58, -0.42, -0.66, -0.12, -0.61);
  shape.bezierCurveTo(0.2, -0.67, 0.58, -0.61, 0.82, -0.4);
  shape.bezierCurveTo(0.96, -0.2, 0.93, 0.12, 0.79, 0.34);
  shape.bezierCurveTo(0.6, 0.57, 0.27, 0.68, -0.05, 0.62);
  shape.bezierCurveTo(-0.38, 0.68, -0.72, 0.56, -0.88, 0.32);
  shape.bezierCurveTo(-1, 0.1, -0.97, -0.18, -0.84, -0.38);
  shape.closePath();
  return shape;
}

function islandOutline(): Shape {
  const shape = new Shape();
  shape.moveTo(-0.23, -0.08);
  shape.bezierCurveTo(-0.18, -0.17, -0.04, -0.2, 0.1, -0.16);
  shape.bezierCurveTo(0.24, -0.12, 0.27, -0.01, 0.2, 0.09);
  shape.bezierCurveTo(0.1, 0.18, -0.08, 0.17, -0.2, 0.1);
  shape.bezierCurveTo(-0.27, 0.05, -0.29, -0.02, -0.23, -0.08);
  shape.closePath();
  return shape;
}

function terrainChunk(shape: Shape, depth: number, name: string): Mesh {
  const mesh = new Mesh(
    new ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelSegments: 3,
      bevelSize: 0.014,
      bevelThickness: 0.008,
      curveSegments: 5,
      steps: 1,
    }),
    [grass, earth],
  );
  mesh.name = name;
  mesh.rotation.x = Math.PI / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function surfacePatch(
  points: Array<[number, number]>,
  material: MeshStandardMaterial,
  name: string,
): Mesh {
  const shape = new Shape();
  shape.moveTo(...points[0]);
  for (const point of points.slice(1)) shape.lineTo(...point);
  shape.closePath();
  const mesh = new Mesh(new ShapeGeometry(shape, 4), material);
  mesh.name = name;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  mesh.receiveShadow = true;
  return mesh;
}

/** 1.86 × 1.32 m organic terrain; origin is centered on its top contact plane. */
export function createOrganicTabletop(): Object3D {
  const root = new Group();
  root.name = 'ChatIRL Organic Tabletop';

  const terrain = terrainChunk(terrainOutline(), 0.032, 'Organic Grassy Terrain');

  const moundGeometry = new SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const moundOne = new Mesh(moundGeometry, lightGrass);
  moundOne.name = 'Northwest Raised Mound';
  moundOne.position.set(-0.52, 0.002, -0.34);
  moundOne.scale.set(0.19, 0.035, 0.14);
  const moundTwo = new Mesh(moundGeometry, coolGrass);
  moundTwo.name = 'Northeast Raised Mound';
  moundTwo.position.set(0.58, 0.002, -0.33);
  moundTwo.scale.set(0.16, 0.028, 0.12);
  const moundThree = new Mesh(moundGeometry, lightGrass);
  moundThree.name = 'Southeast Raised Mound';
  moundThree.position.set(0.57, 0.002, 0.36);
  moundThree.scale.set(0.18, 0.032, 0.13);
  for (const mound of [moundOne, moundTwo, moundThree]) {
    mound.castShadow = true;
    mound.receiveShadow = true;
  }

  root.add(
    terrain,
    moundOne,
    moundTwo,
    moundThree,
    surfacePatch(
      [[-0.72, -0.26], [-0.35, -0.44], [-0.12, -0.25], [-0.28, -0.02], [-0.6, 0.01]],
      lightGrass,
      'Warm Grass Patch',
    ),
    surfacePatch(
      [[0.25, 0.18], [0.69, 0.09], [0.76, 0.34], [0.43, 0.52], [0.16, 0.39]],
      coolGrass,
      'Cool Grass Patch',
    ),
    surfacePatch(
      [[-0.3, -0.16], [0.02, -0.22], [0.26, -0.08], [0.16, 0.1], [-0.2, 0.09]],
      sunnyGrass,
      'Central Sunny Grass Patch',
    ),
    surfacePatch(
      [[-0.48, 0.14], [-0.18, 0.12], [-0.08, 0.3], [-0.34, 0.4], [-0.58, 0.3]],
      deepGrass,
      'West Deep Grass Patch',
    ),
    surfacePatch(
      [[0.2, -0.42], [0.48, -0.48], [0.66, -0.32], [0.48, -0.18], [0.22, -0.24]],
      lightGrass,
      'North Light Grass Patch',
    ),
  );
  return root;
}

/** 54 × 40 cm reusable floating terrain chunk; top contact plane is local Y=0. */
export function createFloatingTerrainIsland(): Object3D {
  const root = new Group();
  root.name = 'ChatIRL Floating Terrain Island';
  const underside = new Mesh(
    new CylinderGeometry(0.2, 0.045, 0.22, 7, 2, false),
    floatingStone,
  );
  underside.name = 'Tapered Stone Underside';
  underside.position.set(0.005, -0.145, 0.006);
  underside.scale.set(1.18, 1, 0.83);
  underside.rotation.y = 0.18;
  underside.castShadow = true;
  underside.receiveShadow = true;
  root.add(terrainChunk(islandOutline(), 0.045, 'Floating Organic Island'), underside);
  return root;
}
