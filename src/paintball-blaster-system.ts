import {
  CanvasTexture,
  createSystem,
  type Entity,
  Grabbed,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Ray,
  Sphere,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
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
const ROUND_SECONDS = 60;
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
  private roundActive = false;
  private roundStartedAt = 0;
  private roundHits = 0;
  private renderedSecond = -1;
  private hitPopUntil = 0;
  private hud: Sprite | null = null;
  private hudCanvas: HTMLCanvasElement | null = null;
  private hitPop: Sprite | null = null;
  private readonly onSelect = (): void => this.fire();
  private readonly onSessionStart = (): void => this.bindSession();

  init(): void {
    this.world.renderer.xr.addEventListener('sessionstart', this.onSessionStart);
    this.bindSession();
    this.createHud();
    const offPickup = this.queries.heldBlasters.subscribe('qualify', () => this.startRound());
    const offRelease = this.queries.heldBlasters.subscribe('disqualify', () => this.stopRound());
    this.cleanupFuncs.push(() => {
      this.world.renderer.xr.removeEventListener('sessionstart', this.onSessionStart);
      this.session?.removeEventListener('select', this.onSelect);
      for (const projectile of this.projectiles) projectile.mesh.removeFromParent();
      this.projectiles.length = 0;
      this.disposeHud();
    });
    this.cleanupFuncs.push(offPickup, offRelease);
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
    this.updateHud(time);
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
    if (this.roundActive) {
      this.roundHits += 1;
      this.hitPopUntil = time + 0.55;
      this.renderHud();
    }
    this.hitCooldowns.set(target.index, time + HIT_COOLDOWN_SECONDS);
  }

  private createHud(): void {
    const parent = this.queries.blasters.entities.values().next().value?.object3D?.parent;
    if (parent == null) return;
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 768;
    this.hudCanvas.height = 420;
    const texture = new CanvasTexture(this.hudCanvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    this.hud = new Sprite(
      new SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
    );
    this.hud.name = 'Paintball Round HUD';
    this.hud.position.set(-0.64, 0.28, 0.43);
    this.hud.scale.set(0.38, 0.21, 1);
    this.hud.renderOrder = 19;
    this.hud.visible = false;
    parent.add(this.hud);

    const popCanvas = document.createElement('canvas');
    popCanvas.width = 256;
    popCanvas.height = 128;
    const context = popCanvas.getContext('2d');
    if (context != null) {
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = '900 88px system-ui, sans-serif';
      context.fillStyle = '#FF3FAD';
      context.strokeStyle = '#FFFFFF';
      context.lineWidth = 10;
      context.strokeText('+1', 128, 65);
      context.fillText('+1', 128, 65);
    }
    const popTexture = new CanvasTexture(popCanvas);
    popTexture.colorSpace = SRGBColorSpace;
    popTexture.minFilter = LinearFilter;
    this.hitPop = new Sprite(
      new SpriteMaterial({ map: popTexture, transparent: true, depthTest: false, opacity: 0 }),
    );
    this.hitPop.name = 'Paintball Hit Plus One';
    this.hitPop.position.set(-0.45, 0.37, 0.43);
    this.hitPop.scale.set(0.001, 0.001, 1);
    this.hitPop.renderOrder = 20;
    this.hitPop.visible = false;
    parent.add(this.hitPop);
  }

  private startRound(): void {
    this.roundActive = true;
    this.roundStartedAt = this.currentTime;
    this.roundHits = 0;
    this.renderedSecond = -1;
    if (this.hud != null) this.hud.visible = true;
    this.renderHud();
  }

  private stopRound(): void {
    this.roundActive = false;
    this.roundStartedAt = 0;
    this.roundHits = 0;
    this.hitPopUntil = 0;
    if (this.hud != null) this.hud.visible = false;
    if (this.hitPop != null) this.hitPop.visible = false;
  }

  private updateHud(time: number): void {
    if (!this.roundActive) return;
    let remaining = Math.max(0, Math.ceil(ROUND_SECONDS - (time - this.roundStartedAt)));
    if (remaining <= 0) {
      this.roundStartedAt = time;
      this.roundHits = 0;
      remaining = ROUND_SECONDS;
    }
    if (remaining !== this.renderedSecond) this.renderHud(remaining);
    if (this.hitPop != null) {
      const remainingPop = this.hitPopUntil - time;
      this.hitPop.visible = remainingPop > 0;
      if (remainingPop > 0) {
        const progress = 1 - remainingPop / 0.55;
        const scale = 0.7 + Math.sin(Math.min(1, progress) * Math.PI) * 0.3;
        this.hitPop.scale.set(0.13 * scale, 0.065 * scale, 1);
        this.hitPop.material.opacity = Math.min(1, remainingPop * 5);
      }
    }
  }

  private renderHud(remaining?: number): void {
    const canvas = this.hudCanvas;
    const hud = this.hud;
    const context = canvas?.getContext('2d');
    if (canvas == null || hud == null || context == null) return;
    const seconds = remaining ?? Math.max(0, Math.ceil(ROUND_SECONDS - (this.currentTime - this.roundStartedAt)));
    this.renderedSecond = seconds;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.shadowColor = 'rgba(255, 43, 150, 0.45)';
    context.shadowBlur = 26;
    context.fillStyle = 'rgba(47, 17, 55, 0.94)';
    context.beginPath();
    context.roundRect(20, 20, 728, 380, 62);
    context.fill();
    context.shadowColor = 'transparent';
    context.strokeStyle = '#FF52B4';
    context.lineWidth = 8;
    context.stroke();
    context.textAlign = 'center';
    context.fillStyle = '#FFD4EC';
    context.font = '700 34px system-ui, sans-serif';
    context.fillText('PAINTBALL ROUND', 384, 85);
    context.fillStyle = '#FF3F9B';
    context.font = '900 118px system-ui, sans-serif';
    context.fillText(`00:${String(seconds).padStart(2, '0')}`, 384, 220);
    context.fillStyle = '#FFFFFF';
    context.font = '800 62px system-ui, sans-serif';
    context.fillText(`HITS: ${this.roundHits}`, 384, 330);
    if (hud.material.map != null) hud.material.map.needsUpdate = true;
  }

  private disposeHud(): void {
    for (const sprite of [this.hud, this.hitPop]) {
      sprite?.removeFromParent();
      sprite?.material.map?.dispose();
      sprite?.material.dispose();
    }
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
