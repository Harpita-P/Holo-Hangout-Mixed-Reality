import {
  BoxGeometry,
  CanvasTexture,
  createSystem,
  type Entity,
  Grabbed,
  GrabSystem,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  MeshStandardMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import type { SandboxCreationSnapshot } from '../shared/community-sandbox.js';
import type { ServerMessage } from '../shared/protocol.js';
import { CommunitySandboxCreation } from './community-sandbox-component.js';

interface CreationRuntime {
  entity: Entity;
  creationId: string;
  meshes: InstancedMesh[];
  label: Sprite | null;
  materializedAt: number;
}

const voxelGeometry = new BoxGeometry(0.0145, 0.0145, 0.0145);
const matrix = new Matrix4();
const voxelMaterials = new Map<string, MeshStandardMaterial>();

export class CommunitySandboxSystem extends createSystem({
  slots: { required: [CommunitySandboxCreation] },
  held: { required: [CommunitySandboxCreation, Grabbed] },
}) {
  private readonly slots: Entity[] = [];
  private readonly runtimes = new Map<number, CreationRuntime>();
  private readonly origins = new Map<Entity, { position: Vector3; quaternion: Quaternion }>();
  private currentTime = 0;
  private grabSystem: GrabSystem | null = null;

  init(): void {
    this.grabSystem = this.world.getSystem(GrabSystem) ?? null;
    this.slots.push(...[...this.queries.slots.entities].sort(
      (left, right) => (left.getValue(CommunitySandboxCreation, 'slot') ?? 0) -
        (right.getValue(CommunitySandboxCreation, 'slot') ?? 0),
    ));
    for (const entity of this.slots) {
      if (entity.object3D == null) continue;
      this.origins.set(entity, {
        position: entity.object3D.position.clone(),
        quaternion: entity.object3D.quaternion.clone(),
      });
      entity.object3D.visible = false;
    }
    const listener = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const message = event.detail as ServerMessage | undefined;
      if (message?.type === 'sandbox.snapshot') this.reconcile(message.sandbox.creations);
      if (message?.type === 'sandbox.creation.ready') this.mount(message.creation);
      if (message?.type === 'sandbox.cleared') this.clear();
    };
    window.addEventListener('holohangout:sandbox-message', listener);
    this.cleanupFuncs.push(() => {
      window.removeEventListener('holohangout:sandbox-message', listener);
      this.clear();
    });
  }

  update(_delta: number, time: number): void {
    this.currentTime = time;
    for (const runtime of this.runtimes.values()) {
      const object = runtime.entity.object3D;
      if (object == null || time - runtime.materializedAt >= 0.5) continue;
      const progress = Math.max(0, Math.min(1, (time - runtime.materializedAt) / 0.5));
      const overshoot = 1 + Math.sin(progress * Math.PI) * 0.14;
      object.scale.setScalar(Math.max(0.001, progress * overshoot));
    }
  }

  private reconcile(creations: SandboxCreationSnapshot[]): void {
    const active = new Set(creations.map(({ slot }) => slot));
    for (const slot of this.runtimes.keys()) if (!active.has(slot)) this.unmount(slot);
    for (const creation of creations) this.mount(creation, false);
  }

  private mount(creation: SandboxCreationSnapshot, animate = true): void {
    const entity = this.slots[creation.slot];
    const object = entity?.object3D;
    if (entity == null || object == null) return;
    if (this.runtimes.get(creation.slot)?.creationId === creation.id) return;
    this.unmount(creation.slot);
    const origin = this.origins.get(entity);
    if (origin != null) {
      object.position.copy(origin.position);
      object.quaternion.copy(origin.quaternion);
    }
    const { blueprint } = creation;
    const byColor = blueprint.palette.map(() => [] as typeof blueprint.voxels);
    for (const voxel of blueprint.voxels) byColor[voxel.color]?.push(voxel);
    const meshes: InstancedMesh[] = [];
    const centerX = (blueprint.size.x - 1) / 2;
    const centerZ = (blueprint.size.z - 1) / 2;
    byColor.forEach((voxels, colorIndex) => {
      if (voxels.length === 0) return;
      const color = blueprint.palette[colorIndex];
      let material = voxelMaterials.get(color);
      if (material == null) {
        material = new MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.02 });
        voxelMaterials.set(color, material);
      }
      const mesh = new InstancedMesh(voxelGeometry, material, voxels.length);
      mesh.name = `${blueprint.name} — palette ${colorIndex + 1}`;
      voxels.forEach((voxel, index) => {
        matrix.makeTranslation(
          (voxel.x - centerX) * 0.0145,
          voxel.y * 0.0145 + 0.00725,
          (voxel.z - centerZ) * 0.0145,
        );
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      object.add(mesh);
      meshes.push(mesh);
    });
    const label = createCreatorLabel(creation.displayName, blueprint.name);
    label.position.set(0, blueprint.size.y * 0.0145 + 0.04, 0);
    object.add(label);
    object.visible = true;
    object.scale.setScalar(animate ? 0.001 : 1);
    entity.setValue(CommunitySandboxCreation, 'creationId', creation.id);
    this.runtimes.set(creation.slot, {
      entity,
      creationId: creation.id,
      meshes,
      label,
      materializedAt: animate ? this.currentTime : Number.NEGATIVE_INFINITY,
    });
  }

  private unmount(slot: number): void {
    const runtime = this.runtimes.get(slot);
    if (runtime == null) return;
    if (this.queries.held.entities.has(runtime.entity)) this.grabSystem?.forceRelease(runtime.entity);
    for (const mesh of runtime.meshes) {
      mesh.removeFromParent();
    }
    runtime.label?.removeFromParent();
    runtime.label?.material.map?.dispose();
    runtime.label?.material.dispose();
    if (runtime.entity.object3D != null) {
      runtime.entity.object3D.visible = false;
      runtime.entity.object3D.scale.setScalar(1);
    }
    runtime.entity.setValue(CommunitySandboxCreation, 'creationId', '');
    this.runtimes.delete(slot);
  }

  private clear(): void {
    for (const slot of [...this.runtimes.keys()]) this.unmount(slot);
  }
}

function createCreatorLabel(displayName: string, objectName: string): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 120;
  const context = canvas.getContext('2d');
  if (context != null) {
    context.fillStyle = 'rgba(41, 32, 65, 0.9)';
    context.beginPath();
    context.roundRect(8, 8, 496, 104, 28);
    context.fill();
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#FFFFFF';
    context.font = '800 34px system-ui, sans-serif';
    context.fillText(objectName, 256, 42, 460);
    context.fillStyle = '#B9FFF6';
    context.font = '650 25px system-ui, sans-serif';
    context.fillText(`Created by ${displayName}`, 256, 84, 460);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.name = 'Sandbox Creation Label';
  sprite.scale.set(0.17, 0.04, 1);
  sprite.renderOrder = 22;
  return sprite;
}
