import {
  createSystem,
  type Entity,
  Grabbed,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Ray,
  Sphere,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { monsterByType, type MonsterType } from '../shared/monsters.js';
import { AvatarBehaviors } from '../shared/protocol.js';
import { MonsterAvatar } from './monster-avatar-component.js';
import { PaintballBlaster } from './paintball-blaster-component.js';
import { ViewerAvatar } from './viewer-avatar-component.js';

const SHOT_COOLDOWN_SECONDS = 0.35;
const HIT_COOLDOWN_SECONDS = 1;
const PROJECTILE_SPEED = 2.4;
const PROJECTILE_RANGE = 3;
const projectileGeometry = new SphereGeometry(0.026, 12, 8);
const projectileMaterial = new MeshBasicMaterial({ color: '#FF3F9B' });

interface PaintballProjectile {
  mesh: Mesh;
  blaster: Entity;
  target: Entity | null;
  hitDistance: number;
  distance: number;
  origin: Vector3;
  direction: Vector3;
}

export class PaintballBlasterSystem extends createSystem({
  blasters: { required: [PaintballBlaster] },
  heldBlasters: { required: [PaintballBlaster, Grabbed] },
  avatars: { required: [ViewerAvatar, MonsterAvatar] },
}) {
  private session: XRSession | null = null;
  private lastShotAt = Number.NEGATIVE_INFINITY;
  private flashUntil = 0;
  private currentTime = 0;
  private readonly hitCooldowns = new Map<number, number>();
  private readonly projectiles: PaintballProjectile[] = [];
  private readonly onSelect = (): void => this.fire();
  private readonly onSessionStart = (): void => this.bindSession();

  init(): void {
    this.world.renderer.xr.addEventListener('sessionstart', this.onSessionStart);
    this.bindSession();
    this.cleanupFuncs.push(() => {
      this.world.renderer.xr.removeEventListener('sessionstart', this.onSessionStart);
      this.session?.removeEventListener('select', this.onSelect);
      for (const projectile of this.projectiles) projectile.mesh.removeFromParent();
      this.projectiles.length = 0;
    });
  }

  update(delta: number, time: number): void {
    this.currentTime = time;
    const blaster = this.queries.blasters.entities.values().next().value;
    const flash = blaster?.object3D?.getObjectByName('Paintball Muzzle Flash');
    if (flash instanceof Mesh) {
      const progress = Math.max(0, (this.flashUntil - time) / 0.09);
      flash.scale.setScalar(progress > 0 ? 0.5 + progress : 0.001);
    }
    this.updateProjectiles(Math.min(delta, 1 / 15), time);
  }

  private bindSession(): void {
    const session = this.world.renderer.xr.getSession();
    if (session === this.session) return;
    this.session?.removeEventListener('select', this.onSelect);
    this.session = session;
    this.session?.addEventListener('select', this.onSelect);
  }

  private fire(): void {
    const time = this.currentTime;
    if (time - this.lastShotAt < SHOT_COOLDOWN_SECONDS) return;
    const blaster = this.queries.heldBlasters.entities.values().next().value;
    const muzzle = blaster?.object3D?.getObjectByName('Paintball Muzzle');
    if (blaster == null || muzzle == null) return;
    this.lastShotAt = time;
    this.flashUntil = time + 0.09;
    blaster.setValue(
      PaintballBlaster,
      'shotsFired',
      (blaster.getValue(PaintballBlaster, 'shotsFired') ?? 0) + 1,
    );

    muzzle.updateWorldMatrix(true, false);
    const origin = muzzle.getWorldPosition(new Vector3());
    const direction = new Vector3(0, 0, -1)
      .applyQuaternion(muzzle.getWorldQuaternion(new Quaternion()))
      .normalize();
    const ray = new Ray(origin, direction);
    const hit = this.closestAvatarHit(ray, origin, time);
    if (hit != null) this.hitCooldowns.set(hit.entity.index, time + HIT_COOLDOWN_SECONDS);
    const mesh = new Mesh(projectileGeometry, projectileMaterial);
    mesh.name = 'Pink Paintball Projectile';
    mesh.position.copy(origin);
    mesh.renderOrder = 25;
    this.world.scene.add(mesh);
    this.projectiles.push({
      mesh,
      blaster,
      target: hit?.entity ?? null,
      hitDistance: hit?.distance ?? PROJECTILE_RANGE,
      distance: 0,
      origin,
      direction,
    });
  }

  private updateProjectiles(delta: number, time: number): void {
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      projectile.distance = Math.min(
        projectile.distance + PROJECTILE_SPEED * delta,
        projectile.hitDistance,
      );
      projectile.mesh.position
        .copy(projectile.origin)
        .addScaledVector(projectile.direction, projectile.distance);
      if (projectile.distance < projectile.hitDistance) continue;
      if (projectile.target != null) this.applyHit(projectile.blaster, projectile.target, time);
      projectile.mesh.removeFromParent();
      this.projectiles.splice(index, 1);
    }
  }

  private applyHit(blaster: Entity, target: Entity, time: number): void {
    const object = target.object3D;
    if (
      object == null ||
      !object.visible ||
      !target.getValue(ViewerAvatar, 'userId') ||
      target.getValue(ViewerAvatar, 'behavior') === AvatarBehaviors.Leaving
    ) {
      return;
    }
    target.setValue(
      ViewerAvatar,
      'paintballHitSequence',
      (target.getValue(ViewerAvatar, 'paintballHitSequence') ?? 0) + 1,
    );
    blaster.setValue(PaintballBlaster, 'hits', (blaster.getValue(PaintballBlaster, 'hits') ?? 0) + 1);
    this.hitCooldowns.set(target.index, time + HIT_COOLDOWN_SECONDS);
  }

  private closestAvatarHit(
    ray: Ray,
    origin: Vector3,
    time: number,
  ): { entity: Entity; distance: number } | null {
    let closest: Entity | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const avatar of this.queries.avatars.entities) {
      const object = avatar.object3D;
      const userId = avatar.getValue(ViewerAvatar, 'userId');
      if (
        object == null ||
        !object.visible ||
        !userId ||
        avatar.getValue(ViewerAvatar, 'behavior') === AvatarBehaviors.Leaving ||
        (this.hitCooldowns.get(avatar.index) ?? 0) > time
      ) {
        continue;
      }
      const monsterType = avatar.getValue(MonsterAvatar, 'monsterType');
      if (monsterType == null) continue;
      const monster = monsterByType(monsterType as MonsterType);
      const center = object.localToWorld(new Vector3(0, monster.targetHeight * 0.52, 0));
      const radius = Math.max(0.055, monster.targetHeight * 0.42);
      const point = ray.intersectSphere(new Sphere(center, radius), new Vector3());
      if (point == null) continue;
      const distance = point.distanceTo(origin);
      if (distance < closestDistance && distance <= 3) {
        closest = avatar;
        closestDistance = distance;
      }
    }
    return closest == null ? null : { entity: closest, distance: closestDistance };
  }
}
