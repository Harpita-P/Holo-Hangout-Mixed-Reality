import { validateVoxelBlueprint, type VoxelBlueprint } from '../shared/community-sandbox.js';

type Builder = ReturnType<typeof createBuilder>;

export function generateMockBlueprint(prompt: string): VoxelBlueprint {
  const normalized = prompt.toLowerCase();
  if (normalized.includes('castle')) return castle();
  if (normalized.includes('tree') || normalized.includes('mushroom')) return tree();
  if (normalized.includes('rocket') || normalized.includes('ship')) return rocket();
  if (normalized.includes('heart') || normalized.includes('love')) return heart();
  return dragon();
}

function createBuilder(name: string, palette: string[], category: string) {
  const voxels = new Map<string, { x: number; y: number; z: number; color: number }>();
  const add = (x: number, y: number, z: number, color = 0): void => {
    if (x < 0 || x > 11 || y < 0 || y > 11 || z < 0 || z > 11 || voxels.size >= 300) return;
    voxels.set(`${x}:${y}:${z}`, { x, y, z, color });
  };
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color = 0): void => {
    for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) for (let z = z0; z <= z1; z += 1) add(x, y, z, color);
  };
  const finish = (description: string): VoxelBlueprint => validateVoxelBlueprint({
    name,
    size: { x: 12, y: 12, z: 12 },
    palette,
    metadata: { description, category, orientation: 'front faces +Z; base rests on y=0' },
    voxels: [...voxels.values()],
  });
  return { add, box, finish };
}

function dragon(): VoxelBlueprint {
  const b = createBuilder('Colorful Dragon', ['#55C96B', '#A78BFA', '#FFD166', '#FF7A59'], 'fantasy creature');
  b.box(4, 7, 1, 4, 4, 7, 0);
  b.box(4, 7, 4, 6, 7, 9, 0);
  b.box(5, 6, 5, 6, 10, 10, 2);
  b.add(4, 6, 9, 2); b.add(7, 6, 9, 2);
  for (let step = 0; step < 5; step += 1) b.add(5 - Math.floor(step / 2), 3 - Math.floor(step / 2), 3 - step, 1);
  for (let x = 1; x <= 3; x += 1) for (let y = 4; y <= 7 - Math.abs(2 - x); y += 1) b.add(x, y, 5, 1);
  for (let x = 8; x <= 10; x += 1) for (let y = 4; y <= 7 - Math.abs(9 - x); y += 1) b.add(x, y, 5, 1);
  b.box(4, 4, 0, 2, 5, 6, 3); b.box(7, 7, 0, 2, 5, 6, 3);
  return b.finish('Cute dragon with a head, horns, body, wings, tail, and sturdy feet.');
}

function castle(): VoxelBlueprint {
  const b = createBuilder('Tiny Pink Castle', ['#F59AC3', '#C084FC', '#FFE08A', '#8B5E83'], 'building');
  b.box(2, 9, 0, 1, 2, 9, 3);
  b.box(3, 8, 2, 6, 3, 8, 0);
  for (const x of [2, 8]) for (const z of [2, 8]) {
    b.box(x, x + 1, 2, 8, z, z + 1, 1);
    b.add(x, 9, z, 2); b.add(x + 1, 9, z + 1, 2);
  }
  b.box(5, 6, 2, 4, 8, 8, 3);
  for (let x = 3; x <= 8; x += 2) b.add(x, 7, 3, 2);
  return b.finish('Playful castle with four towers, battlements, and a front doorway.');
}

function tree(): VoxelBlueprint {
  const b = createBuilder('Rainbow Tree', ['#8B5A3C', '#55C96B', '#4CC9D0', '#F59AC3', '#FFD166'], 'nature');
  b.box(5, 6, 0, 7, 5, 6, 0);
  for (let y = 5; y <= 10; y += 1) {
    const radius = y < 8 ? 3 : y < 10 ? 2 : 1;
    for (let x = 5 - radius; x <= 6 + radius; x += 1) for (let z = 5 - radius; z <= 6 + radius; z += 1) {
      if (Math.abs(x - 5.5) + Math.abs(z - 5.5) <= radius * 1.7) b.add(x, y, z, 1 + ((x + z + y) % 4));
    }
  }
  return b.finish('Rounded rainbow canopy on a sturdy trunk.');
}

function rocket(): VoxelBlueprint {
  const b = createBuilder('Purple Rocket Ship', ['#A78BFA', '#D9F5F5', '#FF6B6B', '#FFD166', '#4CC9D0'], 'vehicle');
  b.box(4, 7, 1, 7, 4, 7, 0);
  b.box(5, 6, 8, 9, 5, 6, 1); b.add(5, 10, 5, 3); b.add(6, 10, 6, 3);
  for (let y = 2; y <= 5; y += 1) { b.add(3, y, 5, 2); b.add(8, y, 6, 2); }
  b.box(5, 6, 0, 0, 5, 6, 3);
  b.add(5, 6, 7, 4); b.add(6, 6, 7, 4);
  return b.finish('Compact rocket with a pointed nose, window, fins, and flame.');
}

function heart(): VoxelBlueprint {
  const b = createBuilder('Golden Heart', ['#FF5D9E', '#FF9BC2', '#FFD166'], 'symbol');
  const rows = [[5, 6], [4, 7], [3, 8], [2, 9], [2, 9], [3, 8], [4, 7], [5, 6]] as const;
  rows.forEach(([from, to], index) => {
    const y = index;
    for (let x = from; x <= to; x += 1) for (let z = 5; z <= 6; z += 1) b.add(x, y, z, index < 3 ? 1 : 0);
  });
  b.add(3, 9, 5, 2); b.add(8, 9, 6, 2);
  return b.finish('Bright, symmetrical voxel heart with a stable point and rounded lobes.');
}
