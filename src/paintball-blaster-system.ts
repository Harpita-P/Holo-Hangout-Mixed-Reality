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
import { battleWinner, segmentHitsSphere } from '../shared/blaster-battle.js';
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
const chatProjectileGeometry = new SphereGeometry(0.032, 12, 8);
const chatProjectileMaterial = new MeshBasicMaterial({ color: '#32D9FF' });
const CHAT_PROJECTILE_SPEED = 1.55;
const CHAT_PROJECTILE_RANGE = 4;

interface PaintballProjectile {
  mesh: Mesh;
  blaster: Entity;
  target: Entity | null;
  hitDistance: number;
  distance: number;
  origin: Vector3;
  direction: Vector3;
}

interface HitPopup {
  sprite: Sprite;
  origin: Vector3;
  startedAt: number;
}

interface ChatBlastProjectile {
  mesh: Mesh;
  previous: Vector3;
  direction: Vector3;
  distance: number;
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
  private chatHits = 0;
  private roundId: string | null = null;
  private winnerMessage = '';
  private winnerUntil = 0;
  private renderedSecond = -1;
  private hud: Sprite | null = null;
  private hudCanvas: HTMLCanvasElement | null = null;
  private hitPopupTexture: CanvasTexture | null = null;
  private readonly hitPopups: HitPopup[] = [];
  private readonly chatProjectiles: ChatBlastProjectile[] = [];
  private readonly onSelect = (): void => this.fire();
  private readonly onSessionStart = (): void => this.bindSession();
  private readonly onViewerBlast = (event: Event): void => {
    const userId = event instanceof CustomEvent ? event.detail?.userId : null;
    if (typeof userId === 'string') this.launchChatProjectile(userId);
  };

  init(): void {
    this.world.renderer.xr.addEventListener('sessionstart', this.onSessionStart);
    this.bindSession();
    this.createHud();
    window.addEventListener('holohangout:viewer-blast', this.onViewerBlast);
    const offPickup = this.queries.heldBlasters.subscribe('qualify', () => this.startRound());
    const offRelease = this.queries.heldBlasters.subscribe('disqualify', () => this.stopRound());
    this.cleanupFuncs.push(() => {
      this.world.renderer.xr.removeEventListener('sessionstart', this.onSessionStart);
      window.removeEventListener('holohangout:viewer-blast', this.onViewerBlast);
      this.session?.removeEventListener('select', this.onSelect);
      for (const projectile of this.projectiles) projectile.mesh.removeFromParent();
      this.projectiles.length = 0;
      for (const projectile of this.chatProjectiles) projectile.mesh.removeFromParent();
      this.chatProjectiles.length = 0;
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
    this.updateChatProjectiles(Math.min(delta, 1 / 15));
    this.updateHud(time);
    this.updateHitPopups(time);
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

  private launchChatProjectile(userId: string): void {
    const avatar = [...this.queries.avatars.entities].find(
      (entity) => entity.getValue(ViewerAvatar, 'userId') === userId,
    );
    const object = avatar?.object3D;
    if (
      avatar == null ||
      object == null ||
      !object.visible ||
      avatar.getValue(ViewerAvatar, 'behavior') === AvatarBehaviors.Leaving
    ) return;
    const monsterType = avatar.getValue(MonsterAvatar, 'monsterType');
    const height = monsterType == null
      ? 0.14
      : monsterByType(monsterType as MonsterType).targetHeight;
    object.updateWorldMatrix(true, false);
    this.world.player.head.updateWorldMatrix(true, false);
    const origin = object.localToWorld(new Vector3(0, height * 0.62, 0));
    const target = this.world.player.head.getWorldPosition(new Vector3());
    target.y -= 0.06;
    const direction = target.sub(origin).normalize();
    if (direction.lengthSq() === 0) return;
    const mesh = new Mesh(chatProjectileGeometry, chatProjectileMaterial);
    mesh.name = `Chat Cyan Blast — ${userId}`;
    mesh.position.copy(origin);
    mesh.renderOrder = 26;
    this.world.scene.add(mesh);
    this.chatProjectiles.push({
      mesh,
      previous: origin.clone(),
      direction,
      distance: 0,
    });
  }

  private updateChatProjectiles(delta: number): void {
    const head = this.world.player.head;
    head.updateWorldMatrix(true, false);
    const headCenter = head.getWorldPosition(new Vector3());
    const torsoCenter = headCenter.clone();
    torsoCenter.y -= 0.27;
    for (let index = this.chatProjectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.chatProjectiles[index];
      projectile.previous.copy(projectile.mesh.position);
      const step = CHAT_PROJECTILE_SPEED * delta;
      projectile.distance += step;
      projectile.mesh.position.addScaledVector(projectile.direction, step);
      const hitStreamer =
        segmentHitsSphere(projectile.previous, projectile.mesh.position, headCenter, 0.14) ||
        segmentHitsSphere(projectile.previous, projectile.mesh.position, torsoCenter, 0.2);
      if (hitStreamer) {
        if (this.roundActive) {
          this.chatHits += 1;
          this.renderHud();
        }
        projectile.mesh.removeFromParent();
        this.chatProjectiles.splice(index, 1);
        continue;
      }
      if (projectile.distance >= CHAT_PROJECTILE_RANGE) {
        projectile.mesh.removeFromParent();
        this.chatProjectiles.splice(index, 1);
      }
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
      this.renderHud();
    }
    this.createHitPopup(target, time);
    this.hitCooldowns.set(target.index, time + HIT_COOLDOWN_SECONDS);
  }

  private createHud(): void {
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 768;
    this.hudCanvas.height = 320;
    const texture = new CanvasTexture(this.hudCanvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    this.hud = new Sprite(
      new SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
    );
    this.hud.name = 'Paintball Round HUD';
    this.hud.position.set(0.18, 0.25, -0.85);
    this.hud.scale.set(0.3, 0.125, 1);
    this.hud.renderOrder = 19;
    this.hud.visible = false;
    this.world.player.head.add(this.hud);

    const popCanvas = document.createElement('canvas');
    popCanvas.width = 256;
    popCanvas.height = 128;
    const context = popCanvas.getContext('2d');
    if (context != null) {
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = '900 88px system-ui, sans-serif';
      context.fillStyle = '#FFE179';
      context.strokeStyle = '#6B1530';
      context.lineWidth = 12;
      context.strokeText('+1', 128, 65);
      context.fillText('+1', 128, 65);
    }
    this.hitPopupTexture = new CanvasTexture(popCanvas);
    this.hitPopupTexture.colorSpace = SRGBColorSpace;
    this.hitPopupTexture.minFilter = LinearFilter;
  }

  private startRound(): void {
    this.roundActive = true;
    this.roundStartedAt = this.currentTime;
    this.roundId = createChallengeId();
    this.roundHits = 0;
    this.chatHits = 0;
    this.winnerMessage = '';
    this.winnerUntil = 0;
    this.renderedSecond = -1;
    if (this.hud != null) this.hud.visible = true;
    this.renderHud();
  }

  private stopRound(): void {
    this.roundActive = false;
    this.roundStartedAt = 0;
    this.roundId = null;
    this.roundHits = 0;
    this.chatHits = 0;
    this.winnerMessage = '';
    this.winnerUntil = 0;
    if (this.hud != null) this.hud.visible = false;
  }

  private updateHud(time: number): void {
    if (!this.roundActive) return;
    let remaining = Math.max(0, Math.ceil(ROUND_SECONDS - (time - this.roundStartedAt)));
    if (remaining <= 0) {
      const winner = battleWinner(this.roundHits, this.chatHits);
      this.winnerMessage = `${
        winner === 'streamer' ? 'STREAMER WINS!' : winner === 'chat' ? 'CHAT WINS!' : 'TIE GAME!'
      }  ${this.roundHits}–${this.chatHits}`;
      this.winnerUntil = time + 3.8;
      if (this.roundId != null) {
        window.dispatchEvent(new CustomEvent('holohangout:challenge-completed', {
          detail: { challengeId: this.roundId },
        }));
      }
      this.roundStartedAt = time;
      this.roundId = createChallengeId();
      this.roundHits = 0;
      this.chatHits = 0;
      remaining = ROUND_SECONDS;
    }
    if (remaining !== this.renderedSecond) this.renderHud(remaining);
  }

  private renderHud(remaining?: number): void {
    const canvas = this.hudCanvas;
    const hud = this.hud;
    const context = canvas?.getContext('2d');
    if (canvas == null || hud == null || context == null) return;
    const seconds = remaining ?? Math.max(0, Math.ceil(ROUND_SECONDS - (this.currentTime - this.roundStartedAt)));
    this.renderedSecond = seconds;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.shadowColor = 'rgba(47, 12, 20, 0.24)';
    context.shadowBlur = 14;
    context.fillStyle = '#752E3B';
    context.beginPath();
    context.roundRect(20, 20, 728, 280, 54);
    context.fill();
    context.shadowColor = 'transparent';
    context.strokeStyle = '#944755';
    context.lineWidth = 7;
    context.stroke();

    // Minimal clock icon, drawn without adding an icon dependency.
    context.strokeStyle = '#FFFFFF';
    context.lineWidth = 9;
    context.beginPath();
    context.arc(151, 125, 43, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.moveTo(151, 125);
    context.lineTo(151, 96);
    context.moveTo(151, 125);
    context.lineTo(176, 140);
    context.stroke();
    context.fillStyle = '#FFFFFF';
    context.font = '900 120px system-ui, sans-serif';
    context.textAlign = 'left';
    context.fillText(`00:${String(seconds).padStart(2, '0')}`, 218, 165);
    context.fillStyle = '#FFFFFF';
    context.font = '800 50px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText(`STREAMER ${this.roundHits}   VS   CHAT ${this.chatHits}`, 384, 245);
    if (this.winnerMessage && this.currentTime < this.winnerUntil) {
      context.fillStyle = '#FFE179';
      context.font = '900 28px system-ui, sans-serif';
      context.fillText(this.winnerMessage, 384, 284);
    }
    if (hud.material.map != null) hud.material.map.needsUpdate = true;
  }

  private disposeHud(): void {
    this.hud?.removeFromParent();
    this.hud?.material.map?.dispose();
    this.hud?.material.dispose();
    for (const popup of this.hitPopups) {
      popup.sprite.removeFromParent();
      popup.sprite.material.dispose();
    }
    this.hitPopups.length = 0;
    this.hitPopupTexture?.dispose();
  }

  private createHitPopup(target: Entity, time: number): void {
    if (this.hitPopupTexture == null || target.object3D == null) return;
    const monsterType = target.getValue(MonsterAvatar, 'monsterType');
    const height = monsterType == null ? 0.14 : monsterByType(monsterType as MonsterType).targetHeight;
    target.object3D.updateWorldMatrix(true, false);
    const origin = target.object3D.localToWorld(new Vector3(0, height * 0.9, 0));
    const sprite = new Sprite(
      new SpriteMaterial({
        map: this.hitPopupTexture,
        transparent: true,
        depthTest: false,
        opacity: 1,
      }),
    );
    sprite.name = 'Paintball Hit Plus One';
    sprite.position.copy(origin);
    sprite.scale.set(0.001, 0.001, 1);
    sprite.renderOrder = 34;
    this.world.scene.add(sprite);
    this.hitPopups.push({ sprite, origin, startedAt: time });
  }

  private updateHitPopups(time: number): void {
    for (let index = this.hitPopups.length - 1; index >= 0; index -= 1) {
      const popup = this.hitPopups[index];
      const elapsed = time - popup.startedAt;
      if (elapsed >= 3) {
        popup.sprite.removeFromParent();
        popup.sprite.material.dispose();
        this.hitPopups.splice(index, 1);
        continue;
      }
      const appear = Math.min(1, elapsed / 0.22);
      const fade = elapsed < 1.8 ? 1 : Math.max(0, (3 - elapsed) / 1.2);
      const scale = 0.82 + 0.18 * Math.sin(appear * Math.PI * 0.5);
      popup.sprite.position.copy(popup.origin);
      popup.sprite.position.y += Math.min(1, elapsed / 3) * 0.12;
      popup.sprite.scale.set(0.16 * scale, 0.08 * scale, 1);
      popup.sprite.material.opacity = Math.min(appear, fade);
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

function createChallengeId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `challenge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
