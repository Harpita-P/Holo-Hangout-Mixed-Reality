import {
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Shape,
  ShapeGeometry,
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

  const terrain = new Mesh(
    new ExtrudeGeometry(terrainOutline(), {
      depth: 0.032,
      bevelEnabled: true,
      bevelSegments: 3,
      bevelSize: 0.014,
      bevelThickness: 0.008,
      curveSegments: 5,
      steps: 1,
    }),
    [grass, earth],
  );
  terrain.name = 'Organic Grassy Terrain';
  terrain.rotation.x = Math.PI / 2;
  terrain.castShadow = true;
  terrain.receiveShadow = true;

  root.add(
    terrain,
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
  );
  return root;
}
