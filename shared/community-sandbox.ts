export const SANDBOX_GRID_SIZE = 12;
export const SANDBOX_MAX_VOXELS = 300;
export const SANDBOX_MAX_COLORS = 8;

export interface VoxelBlueprint {
  name: string;
  size: { x: number; y: number; z: number };
  palette: string[];
  metadata: {
    description: string;
    category: string;
    orientation: string;
  };
  voxels: Array<{ x: number; y: number; z: number; color: number }>;
}

export interface SandboxRequestSnapshot {
  id: string;
  userId: string;
  displayName: string;
  prompt: string;
  status: 'pending' | 'generating';
  createdAt: number;
  expiresAt: number;
}

export interface SandboxCreationSnapshot {
  id: string;
  requestId: string;
  userId: string;
  displayName: string;
  slot: number;
  createdAt: number;
  blueprint: VoxelBlueprint;
}

export interface CommunitySandboxSnapshot {
  active: boolean;
  generator: 'openai' | 'mock';
  apiKeyConfigured: boolean;
  model: string;
  pending: SandboxRequestSnapshot[];
  generating: SandboxRequestSnapshot[];
  creations: SandboxCreationSnapshot[];
  remainingAllowance: number;
  sessionLimit: number;
  lastError: string | null;
}

export const voxelBlueprintJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'size', 'palette', 'metadata', 'voxels'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 40 },
    size: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'z'],
      properties: {
        x: { type: 'integer', minimum: 1, maximum: SANDBOX_GRID_SIZE },
        y: { type: 'integer', minimum: 1, maximum: SANDBOX_GRID_SIZE },
        z: { type: 'integer', minimum: 1, maximum: SANDBOX_GRID_SIZE },
      },
    },
    palette: {
      type: 'array',
      minItems: 1,
      maxItems: SANDBOX_MAX_COLORS,
      items: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
    },
    metadata: {
      type: 'object',
      additionalProperties: false,
      required: ['description', 'category', 'orientation'],
      properties: {
        description: { type: 'string', minLength: 1, maxLength: 120 },
        category: { type: 'string', minLength: 1, maxLength: 30 },
        orientation: { type: 'string', minLength: 1, maxLength: 40 },
      },
    },
    voxels: {
      type: 'array',
      minItems: 8,
      maxItems: SANDBOX_MAX_VOXELS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'z', 'color'],
        properties: {
          x: { type: 'integer', minimum: 0, maximum: SANDBOX_GRID_SIZE - 1 },
          y: { type: 'integer', minimum: 0, maximum: SANDBOX_GRID_SIZE - 1 },
          z: { type: 'integer', minimum: 0, maximum: SANDBOX_GRID_SIZE - 1 },
          color: { type: 'integer', minimum: 0, maximum: SANDBOX_MAX_COLORS - 1 },
        },
      },
    },
  },
} as const;

export function validateVoxelBlueprint(value: unknown): VoxelBlueprint {
  if (typeof value !== 'object' || value == null) throw new Error('Blueprint must be an object.');
  const input = value as Record<string, unknown>;
  const name = cleanText(input.name, 40);
  const metadataInput = requireRecord(input.metadata, 'metadata');
  const metadata = {
    description: cleanText(metadataInput.description, 120),
    category: cleanText(metadataInput.category, 30),
    orientation: cleanText(metadataInput.orientation, 40),
  };
  const sizeInput = requireRecord(input.size, 'size');
  const size = {
    x: boundedInteger(sizeInput.x, 1, SANDBOX_GRID_SIZE, 'size.x'),
    y: boundedInteger(sizeInput.y, 1, SANDBOX_GRID_SIZE, 'size.y'),
    z: boundedInteger(sizeInput.z, 1, SANDBOX_GRID_SIZE, 'size.z'),
  };
  if (!Array.isArray(input.palette) || input.palette.length < 1 || input.palette.length > SANDBOX_MAX_COLORS) {
    throw new Error(`Palette must contain 1–${SANDBOX_MAX_COLORS} colors.`);
  }
  const palette = input.palette.map((color) => {
    if (typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/u.test(color)) {
      throw new Error('Palette colors must use #RRGGBB.');
    }
    return color.toUpperCase();
  });
  if (!Array.isArray(input.voxels) || input.voxels.length < 8 || input.voxels.length > SANDBOX_MAX_VOXELS) {
    throw new Error(`Blueprint must contain 8–${SANDBOX_MAX_VOXELS} voxels.`);
  }
  const occupied = new Set<string>();
  const voxels = input.voxels.map((voxel, index) => {
    const item = requireRecord(voxel, `voxels[${index}]`);
    const result = {
      x: boundedInteger(item.x, 0, size.x - 1, `voxels[${index}].x`),
      y: boundedInteger(item.y, 0, size.y - 1, `voxels[${index}].y`),
      z: boundedInteger(item.z, 0, size.z - 1, `voxels[${index}].z`),
      color: boundedInteger(item.color, 0, palette.length - 1, `voxels[${index}].color`),
    };
    const key = `${result.x}:${result.y}:${result.z}`;
    if (occupied.has(key)) throw new Error(`Duplicate voxel at ${key}.`);
    occupied.add(key);
    return result;
  });
  if (!voxels.some(({ y }) => y === 0)) throw new Error('Blueprint needs a stable base on y=0.');
  return { name, size, palette, metadata, voxels };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is out of bounds.`);
  }
  return value as number;
}

function cleanText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') throw new Error('Blueprint text field is invalid.');
  const result = value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!result || [...result].length > maximum) throw new Error('Blueprint text field is invalid.');
  return result;
}
