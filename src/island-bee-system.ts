import {
  AnimationMixer,
  Box3,
  createSystem,
  LoopRepeat,
  Mesh,
  Quaternion,
  Vector3,
  type Entity,
  type Object3D,
} from '@iwsdk/core';
import { monsterByType, MonsterTypes } from '../shared/monsters.js';
import { IslandBee } from './island-bee-component.js';

interface BeeRuntime {
  entity: Entity;
  visual: Object3D;
  mixer: AnimationMixer;
  center: Vector3;
  phase: number;
  radius: number;
  hoverHeight: number;
}

const direction = new Vector3();

export class IslandBeeSystem extends createSystem({
  bees: { required: [IslandBee] },
}) {
  private readonly runtimes: BeeRuntime[] = [];

  init(): void {
    for (const entity of this.queries.bees.entities) this.mountBee(entity);
    this.cleanupFuncs.push(() => {
      for (const runtime of this.runtimes) {
        runtime.mixer.stopAllAction();
        runtime.visual.removeFromParent();
      }
      this.runtimes.length = 0;
    });
  }

  update(delta: number, time: number): void {
    for (const runtime of this.runtimes) {
      const object = runtime.entity.object3D;
      if (object == null) continue;
      const angle = runtime.phase + time * 0.42;
      const nextAngle = angle + 0.03;
      object.position.set(
        runtime.center.x + Math.cos(angle) * runtime.radius,
        runtime.center.y + runtime.hoverHeight + Math.sin(time * 2.2 + runtime.phase) * 0.014,
        runtime.center.z + Math.sin(angle) * runtime.radius * 0.68,
      );
      direction.set(
        Math.cos(nextAngle) - Math.cos(angle),
        0,
        (Math.sin(nextAngle) - Math.sin(angle)) * 0.68,
      ).normalize();
      if (direction.lengthSq() > 0) {
        object.quaternion.slerp(
          new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), direction).normalize(),
          Math.min(1, delta * 5),
        );
      }
      runtime.mixer.update(Math.min(delta, 1 / 15));
    }
  }

  private mountBee(entity: Entity): void {
    const object = entity.object3D;
    const gltf = this.world.assetManager.getGLTF('monster-bee');
    if (object == null || gltf == null) return;
    for (const child of object.children) child.visible = false;
    const visual = gltf.scene;
    visual.name = 'Ambient Island Bee Visual';
    visual.traverse((child) => {
      if (child instanceof Mesh) child.castShadow = true;
    });
    const bounds = new Box3().setFromObject(visual);
    const size = bounds.getSize(new Vector3());
    const targetHeight = monsterByType(MonsterTypes.Bee).targetHeight;
    visual.scale.multiplyScalar(size.y > 0 ? targetHeight / size.y : 1);
    visual.updateMatrixWorld(true);
    bounds.setFromObject(visual);
    const center = bounds.getCenter(new Vector3());
    visual.position.set(-center.x, -bounds.min.y, -center.z);
    object.add(visual);
    const mixer = new AnimationMixer(visual);
    const clip = gltf.animations.find(({ name }) => name === 'Fast_Flying') ??
      gltf.animations.find(({ name }) => name === 'Flying_Idle');
    if (clip != null) mixer.clipAction(clip).setLoop(LoopRepeat, Infinity).play();
    this.runtimes.push({
      entity,
      visual,
      mixer,
      center: object.position.clone(),
      phase: entity.getValue(IslandBee, 'phase') ?? 0,
      radius: entity.getValue(IslandBee, 'radius') ?? 0.11,
      hoverHeight: entity.getValue(IslandBee, 'hoverHeight') ?? 0.23,
    });
  }
}
