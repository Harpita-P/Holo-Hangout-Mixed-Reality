export interface AvatarHabitat {
  centerX: number;
  centerZ: number;
  radius: number;
  baseY: number;
  bobAmplitude: number;
  bobSpeed: number;
  bobPhase: number;
}

const BOT_HABITATS: Readonly<Record<string, AvatarHabitat>> = {};

export function habitatForUser(userId: string): AvatarHabitat | null {
  return BOT_HABITATS[userId] ?? null;
}

export function clampToHabitat(
  habitat: AvatarHabitat,
  x: number,
  z: number,
): { x: number; z: number } {
  const dx = x - habitat.centerX;
  const dz = z - habitat.centerZ;
  const distance = Math.hypot(dx, dz);
  if (distance <= habitat.radius || distance === 0) return { x, z };
  return {
    x: habitat.centerX + (dx / distance) * habitat.radius,
    z: habitat.centerZ + (dz / distance) * habitat.radius,
  };
}

export function habitatHeight(habitat: AvatarHabitat, time: number): number {
  return habitat.baseY + Math.sin(time * habitat.bobSpeed + habitat.bobPhase) * habitat.bobAmplitude;
}
