import { createSystem, type Entity } from '@iwsdk/core';
import { FloatingTerrain } from './floating-terrain-component.js';

export class FloatingTerrainSystem extends createSystem({
  islands: { required: [FloatingTerrain] },
}) {
  private readonly baseHeights = new Map<Entity, number>();

  update(_delta: number, time: number): void {
    for (const entity of this.queries.islands.entities) {
      const object = entity.object3D;
      if (object == null) continue;
      let baseHeight = this.baseHeights.get(entity);
      if (baseHeight == null) {
        baseHeight = object.position.y;
        this.baseHeights.set(entity, baseHeight);
      }
      const amplitude = entity.getValue(FloatingTerrain, 'amplitude') ?? 0.01;
      const speed = entity.getValue(FloatingTerrain, 'speed') ?? 0.8;
      const phase = entity.getValue(FloatingTerrain, 'phase') ?? 0;
      object.position.y = baseHeight + Math.sin(time * speed + phase) * amplitude;
    }
  }
}
