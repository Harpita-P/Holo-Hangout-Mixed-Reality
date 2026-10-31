export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export type BattleWinner = 'streamer' | 'chat' | 'tie';

export function segmentHitsSphere(
  start: Point3,
  end: Point3,
  center: Point3,
  radius: number,
): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const projection = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, (
        (center.x - start.x) * dx +
        (center.y - start.y) * dy +
        (center.z - start.z) * dz
      ) / lengthSquared));
  const x = start.x + dx * projection - center.x;
  const y = start.y + dy * projection - center.y;
  const z = start.z + dz * projection - center.z;
  return x * x + y * y + z * z <= radius * radius;
}

export function battleWinner(streamerHits: number, chatHits: number): BattleWinner {
  if (streamerHits > chatHits) return 'streamer';
  if (chatHits > streamerHits) return 'chat';
  return 'tie';
}
