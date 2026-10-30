import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  Box3,
  CanvasTexture,
  Color,
  createSystem,
  type Entity,
  Grabbed,
  GrabSystem,
  LinearFilter,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshStandardMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Object3D,
  Vector3,
} from '@iwsdk/core';
import {
  commandForBehavior,
  MONSTER_AUTONOMY_CLIPS,
  monsterByType,
  MonsterCategories,
  type MonsterDefinition,
} from '../shared/monsters.js';
import {
  AvatarBehaviors,
  type AvatarBehavior,
  type ParticipantSnapshot,
  type ServerMessage,
} from '../shared/protocol.js';
import { ChatIRLSocket, type SocketStatus } from './chatirl-socket.js';
import { MonsterAvatar, MonsterStates } from './monster-avatar-component.js';
import { ViewerAvatar } from './viewer-avatar-component.js';

interface AvatarRuntime {
  entity: Entity;
  initialX: number;
  initialY: number;
  initialZ: number;
  actionStartedAt: number;
  leavingAt: number;
  spawnEndsAt: number;
  fallbackChildren: Object3D[];
  leftArm: Object3D | null;
  rightArm: Object3D | null;
  label: Sprite | null;
  labelText: string;
  bubble: Sprite | null;
  bubbleText: string;
  bubbleShownAt: number;
  bubbleExpiresAt: number;
  splatter: Sprite | null;
  hitStartedAt: number;
  hitRespawnAt: number;
  hitOriginX: number;
  hitOriginZ: number;
  lastHitSequence: number;
  monster: MonsterDefinition | null;
  monsterVisual: Object3D | null;
  mixer: AnimationMixer | null;
  clips: Map<string, AnimationClip>;
  activeAction: AnimationAction | null;
  activeClip: string;
  activeLoop: boolean;
  clipEndsAt: number;
  commandBehavior: AvatarBehavior | null;
  commandQueue: string[];
  commandQueueIndex: number;
  commandMoves: boolean;
  commandStartedAt: number;
  commandDuration: number;
  lastActionSequence: number;
  held: boolean;
  moving: boolean;
  destinationX: number;
  destinationZ: number;
  nextDecisionAt: number;
  autonomySequence: number;
}

const TABLE_MIN_X = -0.765;
const TABLE_MAX_X = 0.765;
const TABLE_MIN_Z = -0.495;
const TABLE_MAX_Z = 0.495;
const TERRAIN_RADIUS_X = 0.79;
const TERRAIN_RADIUS_Z = 0.49;
const TERRAIN_OBSTACLES = [
  { x: -0.52, z: -0.34, radius: 0.18 },
  { x: 0.58, z: -0.33, radius: 0.15 },
  { x: 0.57, z: 0.36, radius: 0.17 },
] as const;
const proceduralFallbackRequested =
  new URLSearchParams(window.location.search).get('proceduralAvatars') === '1';

export class ViewerAvatarSystem extends createSystem({
  avatars: { required: [ViewerAvatar] },
  held: { required: [ViewerAvatar, Grabbed] },
}) {
  private readonly messageQueue: ServerMessage[] = [];
  private readonly runtimes = new Map<Entity, AvatarRuntime>();
  private readonly userEntities = new Map<string, Entity>();
  private readonly slots: Entity[] = [];
  private socket!: ChatIRLSocket;
  private grabSystem: GrabSystem | null = null;
  private statusElement: HTMLElement | null = null;
  private backendConnected = false;
  private twitchConnected = false;
  private broadcasterLogin: string | null = null;
  private currentTime = 0;

  init(): void {
    this.statusElement = document.getElementById('connection-status');
    this.grabSystem = this.world.getSystem(GrabSystem) ?? null;
    this.slots.push(
      ...[...this.queries.avatars.entities].sort((left, right) =>
        (left.object3D?.name ?? '').localeCompare(right.object3D?.name ?? ''),
      ),
    );
    for (const entity of this.slots) this.prepareSlot(entity);

    const offHeld = this.queries.held.subscribe('qualify', (entity) => {
      const runtime = this.runtimes.get(entity);
      if (runtime != null) {
        runtime.held = true;
        entity.setValue(MonsterAvatar, 'state', MonsterStates.Held);
        this.playFirstAvailable(runtime, ['HitReact', 'HitRecieve'], false, this.currentTime);
      }
      const userId = entity.getValue(ViewerAvatar, 'userId');
      if (userId) this.socket?.send({ type: 'avatar.held', userId, held: true });
    });
    const offReleased = this.queries.held.subscribe('disqualify', (entity) => {
      const runtime = this.runtimes.get(entity);
      if (runtime != null) runtime.held = false;
      this.settleOnTable(entity);
      const behavior = entity.getValue(ViewerAvatar, 'behavior') as AvatarBehavior | null;
      if (runtime != null && behavior !== AvatarBehaviors.Leaving) {
        if (behavior != null && behavior !== AvatarBehaviors.Idle) {
          this.startCommand(runtime, behavior, this.currentTime);
        } else {
          runtime.nextDecisionAt = this.currentTime;
          entity.setValue(MonsterAvatar, 'state', MonsterStates.Autonomous);
        }
      }
      const userId = entity.getValue(ViewerAvatar, 'userId');
      if (userId) this.socket?.send({ type: 'avatar.held', userId, held: false });
    });
    this.cleanupFuncs.push(offHeld, offReleased);

    this.socket = new ChatIRLSocket(
      (message) => this.messageQueue.push(message),
      (status) => this.setSocketStatus(status),
    );
    this.cleanupFuncs.push(() => this.socket.close());
  }

  update(delta: number, time: number): void {
    this.currentTime = time;
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message != null) this.applyMessage(message, time);
    }
    for (const [entity, runtime] of this.runtimes) {
      this.syncPaintballHit(runtime, time);
      this.updateBubble(runtime, time);
      if (runtime.hitRespawnAt > 0) {
        this.updatePaintballHit(runtime, time);
        continue;
      }
      if (!entity.object3D?.visible) continue;
      runtime.mixer?.update(Math.min(delta, 1 / 15));
      if (runtime.held || this.queries.held.entities.has(entity)) continue;
      this.animate(entity, runtime, delta, time);
    }
  }

  private prepareSlot(entity: Entity): void {
    const object = entity.object3D;
    if (object == null) return;
    object.visible = false;
    object.traverse((child) => {
      if (!(child instanceof Mesh) || !(child.material instanceof MeshStandardMaterial)) return;
      child.material = child.material.clone();
    });
    if (!entity.hasComponent(MonsterAvatar)) entity.addComponent(MonsterAvatar);
    this.runtimes.set(entity, {
      entity,
      initialX: object.position.x,
      initialY: object.position.y,
      initialZ: object.position.z,
      actionStartedAt: 0,
      leavingAt: 0,
      spawnEndsAt: 0,
      fallbackChildren: [...object.children],
      leftArm: object.getObjectByName('Left Arm') ?? null,
      rightArm: object.getObjectByName('Right Arm') ?? null,
      label: null,
      labelText: '',
      bubble: null,
      bubbleText: '',
      bubbleShownAt: 0,
      bubbleExpiresAt: 0,
      splatter: null,
      hitStartedAt: 0,
      hitRespawnAt: 0,
      hitOriginX: object.position.x,
      hitOriginZ: object.position.z,
      lastHitSequence: entity.getValue(ViewerAvatar, 'paintballHitSequence') ?? 0,
      monster: null,
      monsterVisual: null,
      mixer: null,
      clips: new Map(),
      activeAction: null,
      activeClip: '',
      activeLoop: false,
      clipEndsAt: 0,
      commandBehavior: null,
      commandQueue: [],
      commandQueueIndex: 0,
      commandMoves: false,
      commandStartedAt: 0,
      commandDuration: 0,
      lastActionSequence: -1,
      held: false,
      moving: false,
      destinationX: object.position.x,
      destinationZ: object.position.z,
      nextDecisionAt: 0,
      autonomySequence: 0,
    });
  }

  private applyMessage(message: ServerMessage, time: number): void {
    switch (message.type) {
      case 'session.snapshot':
        this.reconcileSnapshot(message.participants, time);
        break;
      case 'avatar.join':
        this.activate(message.participant, time);
        break;
      case 'avatar.chat':
        this.showBubble(message.userId, message.text, time);
        break;
      case 'avatar.action':
        this.applyAction(message.userId, message.behavior, message.actionSequence, message.targetX, message.targetZ, time);
        break;
      case 'avatar.leave':
        this.beginLeave(message.userId, message.deadlineMs, time);
        break;
      case 'avatar.removed':
        this.deactivate(message.userId);
        break;
      case 'server.status':
        this.twitchConnected = message.twitchConnected;
        this.broadcasterLogin = message.broadcasterLogin;
        this.renderStatus();
        break;
    }
  }

  private reconcileSnapshot(participants: ParticipantSnapshot[], time: number): void {
    const active = new Set(participants.map(({ userId }) => userId));
    for (const userId of this.userEntities.keys()) {
      if (!active.has(userId)) this.beginLeave(userId, 350, time);
    }
    for (const participant of participants) this.activate(participant, time);
  }

  private activate(participant: ParticipantSnapshot, time: number): void {
    const entity = this.slots[participant.slot];
    const runtime = entity == null ? null : this.runtimes.get(entity);
    if (entity == null || runtime == null || entity.object3D == null) return;

    const previousUser = entity.getValue(ViewerAvatar, 'userId');
    if (previousUser && previousUser !== participant.userId) this.deactivate(previousUser);
    const previousEntity = this.userEntities.get(participant.userId);
    if (previousEntity != null && previousEntity !== entity) this.deactivate(participant.userId);

    const object = entity.object3D;
    const wasVisible = object.visible || runtime.hitRespawnAt > 0;
    this.userEntities.set(participant.userId, entity);
    entity.setValue(ViewerAvatar, 'userId', participant.userId);
    entity.setValue(ViewerAvatar, 'displayName', participant.displayName);
    entity.setValue(ViewerAvatar, 'colorHex', participant.colorHex);
    entity.setValue(ViewerAvatar, 'behavior', participant.behavior);
    entity.setValue(ViewerAvatar, 'actionSequence', participant.actionSequence);
    entity.setValue(ViewerAvatar, 'targetX', participant.targetX);
    entity.setValue(ViewerAvatar, 'targetZ', participant.targetZ);

    const monster = monsterByType(participant.monsterType);
    this.mountMonster(runtime, monster);
    entity.setValue(MonsterAvatar, 'monsterType', monster.type);
    entity.setValue(MonsterAvatar, 'category', monster.category);

    if (!wasVisible) {
      entity.setValue(MonsterAvatar, 'state', MonsterStates.Spawn);
      object.position.set(runtime.initialX, this.restingY(runtime, time), runtime.initialZ);
      object.rotation.set(0, 0, 0);
      object.scale.setScalar(0.001);
      runtime.spawnEndsAt = time + 0.35;
      runtime.nextDecisionAt = time + 0.65 + seededUnit(entity.index, 1) * 1.2;
    }
    object.visible = runtime.hitRespawnAt <= 0;
    runtime.actionStartedAt = time;
    runtime.leavingAt = 0;
    this.applyColor(object, participant.colorHex);
    this.setLabel(runtime, participant.displayName);
    if (!wasVisible && participant.behavior === AvatarBehaviors.Idle) {
      const idleClip = MONSTER_AUTONOMY_CLIPS[monster.category].idle;
      this.playClip(runtime, idleClip, true, time);
    }

    if (runtime.lastActionSequence !== participant.actionSequence) {
      runtime.lastActionSequence = participant.actionSequence;
      if (participant.behavior !== AvatarBehaviors.Idle) {
        this.startCommand(runtime, participant.behavior, time);
      }
    }
  }

  private mountMonster(runtime: AvatarRuntime, monster: MonsterDefinition): void {
    if (runtime.monster?.type === monster.type && runtime.monsterVisual != null) return;
    runtime.mixer?.stopAllAction();
    runtime.monsterVisual?.removeFromParent();
    runtime.monster = monster;
    runtime.monsterVisual = null;
    runtime.mixer = null;
    runtime.clips.clear();
    runtime.activeAction = null;
    runtime.activeClip = '';
    for (const child of runtime.fallbackChildren) child.visible = true;
    if (proceduralFallbackRequested) return;

    const gltf = this.world.assetManager.getGLTF(monster.assetId);
    if (gltf == null) {
      console.warn(`ChatIRL monster asset was not cached: ${monster.assetId}`);
      return;
    }
    const visual = gltf.scene;
    visual.name = `Monster Visual — ${monster.name}`;
    visual.traverse((child) => {
      if (child instanceof Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    const bounds = new Box3().setFromObject(visual);
    const size = bounds.getSize(new Vector3());
    const scale = size.y > 0 ? monster.targetHeight / size.y : 1;
    visual.scale.multiplyScalar(scale);
    visual.updateMatrixWorld(true);
    bounds.setFromObject(visual);
    const center = bounds.getCenter(new Vector3());
    visual.position.x -= center.x;
    visual.position.y -= bounds.min.y;
    visual.position.z -= center.z;
    runtime.entity.object3D?.add(visual);
    for (const child of runtime.fallbackChildren) child.visible = false;
    runtime.monsterVisual = visual;
    runtime.mixer = new AnimationMixer(visual);
    runtime.clips = new Map(gltf.animations.map((clip) => [clip.name, clip]));
  }

  private applyAction(
    userId: string,
    behavior: AvatarBehavior,
    actionSequence: number,
    targetX: number,
    targetZ: number,
    time: number,
  ): void {
    const entity = this.userEntities.get(userId);
    const runtime = entity == null ? null : this.runtimes.get(entity);
    if (entity == null || runtime == null) return;
    entity.setValue(ViewerAvatar, 'behavior', behavior);
    entity.setValue(ViewerAvatar, 'actionSequence', actionSequence);
    entity.setValue(ViewerAvatar, 'targetX', targetX);
    entity.setValue(ViewerAvatar, 'targetZ', targetZ);
    runtime.lastActionSequence = actionSequence;
    runtime.actionStartedAt = time;
    if (behavior === AvatarBehaviors.Idle) {
      this.finishCommand(runtime, time);
    } else if (!runtime.held) {
      this.startCommand(runtime, behavior, time);
    }
  }

  private startCommand(runtime: AvatarRuntime, behavior: AvatarBehavior, time: number): void {
    const category = runtime.monster?.category;
    if (category == null) return;
    const command = commandForBehavior(category, behavior);
    if (command == null) return;
    runtime.commandBehavior = behavior;
    runtime.commandQueue = [...command.clips];
    runtime.commandQueueIndex = 0;
    runtime.commandMoves = command.moves;
    runtime.commandStartedAt = time;
    runtime.commandDuration = runtime.commandQueue.reduce(
      (duration, name) => duration + (runtime.clips.get(name)?.duration ?? 0),
      0,
    );
    runtime.moving = false;
    runtime.entity.setValue(MonsterAvatar, 'state', MonsterStates.Command);
    this.playClip(runtime, runtime.commandQueue[0], command.moves, time);
  }

  private finishCommand(runtime: AvatarRuntime, time: number): void {
    runtime.commandBehavior = null;
    runtime.commandQueue = [];
    runtime.commandQueueIndex = 0;
    runtime.commandMoves = false;
    runtime.entity.setValue(MonsterAvatar, 'state', MonsterStates.Autonomous);
    runtime.nextDecisionAt = Math.min(runtime.nextDecisionAt, time + 0.4);
    this.playAutonomyClip(runtime, runtime.moving, time);
  }

  private beginLeave(userId: string, deadlineMs: number, time: number): void {
    const entity = this.userEntities.get(userId);
    const runtime = entity == null ? null : this.runtimes.get(entity);
    if (entity == null || runtime == null) return;
    entity.setValue(ViewerAvatar, 'behavior', AvatarBehaviors.Leaving);
    entity.setValue(MonsterAvatar, 'state', MonsterStates.Leaving);
    runtime.hitRespawnAt = 0;
    this.removePaintSplatter(runtime);
    if (entity.object3D != null) {
      entity.object3D.visible = true;
      entity.object3D.scale.setScalar(1);
    }
    runtime.commandBehavior = null;
    runtime.actionStartedAt = time;
    runtime.leavingAt = time + Math.max(0, Math.min(deadlineMs, 1000)) / 1000;
    this.removeBubble(runtime);
    this.playClip(runtime, 'Death', false, time);
    if (this.queries.held.entities.has(entity)) this.grabSystem?.forceRelease(entity);
  }

  private deactivate(userId: string): void {
    const entity = this.userEntities.get(userId);
    const runtime = entity == null ? null : this.runtimes.get(entity);
    if (entity == null || runtime == null || entity.object3D == null) return;
    if (this.queries.held.entities.has(entity)) this.grabSystem?.forceRelease(entity);
    runtime.mixer?.stopAllAction();
    runtime.activeAction = null;
    runtime.activeClip = '';
    runtime.commandBehavior = null;
    runtime.moving = false;
    entity.object3D.visible = false;
    entity.object3D.scale.setScalar(1);
    entity.setValue(ViewerAvatar, 'userId', '');
    entity.setValue(ViewerAvatar, 'displayName', '');
    entity.setValue(ViewerAvatar, 'behavior', AvatarBehaviors.Idle);
    entity.setValue(ViewerAvatar, 'paintballHitSequence', 0);
    entity.setValue(MonsterAvatar, 'state', MonsterStates.Autonomous);
    entity.setValue(MonsterAvatar, 'activeClip', '');
    runtime.hitRespawnAt = 0;
    runtime.lastHitSequence = 0;
    this.removePaintSplatter(runtime);
    this.removeBubble(runtime);
    this.removeLabel(runtime);
    this.userEntities.delete(userId);
  }

  private syncPaintballHit(runtime: AvatarRuntime, time: number): void {
    const sequence = runtime.entity.getValue(ViewerAvatar, 'paintballHitSequence') ?? 0;
    if (sequence === runtime.lastHitSequence) return;
    runtime.lastHitSequence = sequence;
    if (sequence > 0) this.beginPaintballHit(runtime, time);
  }

  private beginPaintballHit(runtime: AvatarRuntime, time: number): void {
    const entity = runtime.entity;
    const object = entity.object3D;
    if (
      object == null ||
      !object.visible ||
      entity.getValue(ViewerAvatar, 'behavior') === AvatarBehaviors.Leaving
    ) {
      return;
    }
    if (this.queries.held.entities.has(entity)) this.grabSystem?.forceRelease(entity);
    runtime.hitOriginX = object.position.x;
    runtime.hitOriginZ = object.position.z;
    runtime.hitStartedAt = time;
    runtime.hitRespawnAt = time + 0.58;
    runtime.moving = false;
    this.removePaintSplatter(runtime);
    runtime.splatter = this.createPaintSplatter(runtime);
    object.visible = false;
  }

  private createPaintSplatter(runtime: AvatarRuntime): Sprite | null {
    const object = runtime.entity.object3D;
    const parent = object?.parent;
    if (object == null || parent == null) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (context == null) return null;
    context.fillStyle = '#FF3F9B';
    context.beginPath();
    context.arc(128, 128, 62, 0, Math.PI * 2);
    for (let index = 0; index < 10; index += 1) {
      const angle = (index / 10) * Math.PI * 2;
      const distance = index % 2 === 0 ? 88 : 74;
      context.moveTo(128 + Math.cos(angle) * distance + 14, 128 + Math.sin(angle) * distance);
      context.arc(
        128 + Math.cos(angle) * distance,
        128 + Math.sin(angle) * distance,
        index % 2 === 0 ? 14 : 9,
        0,
        Math.PI * 2,
      );
    }
    context.fill();
    context.fillStyle = '#FFD2E8';
    context.beginPath();
    context.arc(109, 105, 18, 0, Math.PI * 2);
    context.fill();

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const splatter = new Sprite(material);
    splatter.name = 'Paintball Pink Splatter';
    splatter.position.copy(object.position);
    splatter.position.y += (runtime.monster?.targetHeight ?? 0.18) * 0.55;
    splatter.scale.setScalar(0.001);
    splatter.renderOrder = 30;
    parent.add(splatter);
    return splatter;
  }

  private updatePaintballHit(runtime: AvatarRuntime, time: number): void {
    const elapsed = Math.max(0, time - runtime.hitStartedAt);
    if (runtime.splatter != null) {
      const pop = elasticOut(clamp(elapsed / 0.16, 0, 1));
      const fade = 1 - clamp((elapsed - 0.3) / 0.25, 0, 1);
      runtime.splatter.scale.setScalar(0.28 + pop * 0.22);
      runtime.splatter.material.opacity = fade;
    }
    if (time < runtime.hitRespawnAt) return;
    const object = runtime.entity.object3D;
    if (object == null) return;
    const next = this.pickRespawnPosition(runtime);
    object.position.set(next.x, this.restingY(runtime, time), next.z);
    object.rotation.set(0, 0, 0);
    object.scale.setScalar(0.001);
    object.visible = true;
    runtime.hitRespawnAt = 0;
    runtime.spawnEndsAt = time + 0.35;
    runtime.nextDecisionAt = time + 0.8;
    runtime.entity.setValue(MonsterAvatar, 'state', MonsterStates.Spawn);
    this.removePaintSplatter(runtime);
  }

  private pickRespawnPosition(runtime: AvatarRuntime): { x: number; z: number } {
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const sequence = runtime.lastHitSequence * 17 + attempt;
      const candidate = {
        x: TABLE_MIN_X + 0.04 + seededUnit(runtime.entity.index, sequence) * (TABLE_MAX_X - TABLE_MIN_X - 0.08),
        z: TABLE_MIN_Z + 0.04 + seededUnit(runtime.entity.index + 29, sequence) * (TABLE_MAX_Z - TABLE_MIN_Z - 0.08),
      };
      if (
        isPlayablePosition(candidate.x, candidate.z) &&
        Math.hypot(candidate.x - runtime.hitOriginX, candidate.z - runtime.hitOriginZ) >= 0.28
      ) {
        return candidate;
      }
    }
    return { x: -runtime.hitOriginX * 0.7, z: -runtime.hitOriginZ * 0.7 };
  }

  private removePaintSplatter(runtime: AvatarRuntime): void {
    const splatter = runtime.splatter;
    if (splatter == null) return;
    splatter.removeFromParent();
    splatter.material.map?.dispose();
    splatter.material.dispose();
    runtime.splatter = null;
  }

  private animate(entity: Entity, runtime: AvatarRuntime, delta: number, time: number): void {
    const object = entity.object3D;
    if (object == null) return;
    const behavior = entity.getValue(ViewerAvatar, 'behavior');
    if (behavior === AvatarBehaviors.Leaving) {
      const remaining = Math.max(0, runtime.leavingAt - time);
      object.rotation.y += Math.min(delta, 1 / 15) * 5;
      object.scale.setScalar(Math.max(0.001, Math.min(1, remaining * 4)));
      if (time >= runtime.leavingAt) {
        const userId = entity.getValue(ViewerAvatar, 'userId');
        if (userId) this.deactivate(userId);
      }
      return;
    }

    if (time < runtime.spawnEndsAt) {
      const progress = 1 - (runtime.spawnEndsAt - time) / 0.35;
      object.scale.setScalar(Math.max(0.001, elasticOut(progress)));
    } else {
      object.scale.setScalar(1);
      if (entity.getValue(MonsterAvatar, 'state') === MonsterStates.Spawn) {
        entity.setValue(MonsterAvatar, 'state', MonsterStates.Autonomous);
      }
    }

    if (runtime.monsterVisual == null) {
      this.animateFallback(entity, runtime, delta, time);
      return;
    }
    if (runtime.commandBehavior != null) {
      this.updateCommand(entity, runtime, delta, time);
    } else {
      this.updateAutonomy(entity, runtime, delta, time);
    }
  }

  private updateCommand(entity: Entity, runtime: AvatarRuntime, delta: number, time: number): void {
    const behavior = runtime.commandBehavior;
    if (behavior == null) return;
    if (runtime.commandMoves) {
      const targetX = entity.getValue(ViewerAvatar, 'targetX') ?? runtime.destinationX;
      const targetZ = entity.getValue(ViewerAvatar, 'targetZ') ?? runtime.destinationZ;
      const speed = behavior === AvatarBehaviors.Walk ? 0.1 : behavior === AvatarBehaviors.Fly ? 0.25 : 0.2;
      if (this.moveToward(runtime, targetX, targetZ, speed, delta)) {
        entity.setValue(ViewerAvatar, 'behavior', AvatarBehaviors.Idle);
        this.finishCommand(runtime, time);
      }
    } else if (time >= runtime.clipEndsAt) {
      runtime.commandQueueIndex += 1;
      const next = runtime.commandQueue[runtime.commandQueueIndex];
      if (next != null) {
        this.playClip(runtime, next, false, time);
      } else {
        entity.setValue(ViewerAvatar, 'behavior', AvatarBehaviors.Idle);
        this.finishCommand(runtime, time);
      }
    }
    if (behavior === AvatarBehaviors.Jump && runtime.commandDuration > 0) {
      const progress = Math.min(1, (time - runtime.commandStartedAt) / runtime.commandDuration);
      entity.object3D!.position.y = this.restingY(runtime, time) + Math.sin(progress * Math.PI) * 0.038;
    } else {
      entity.object3D!.position.y = this.restingY(runtime, time);
    }
  }

  private updateAutonomy(entity: Entity, runtime: AvatarRuntime, delta: number, time: number): void {
    if (time >= runtime.nextDecisionAt) this.chooseAutonomousState(runtime, time);
    if (runtime.moving) {
      const speed = runtime.monster?.category === MonsterCategories.Flying ? 0.065 : 0.045;
      if (this.moveToward(runtime, runtime.destinationX, runtime.destinationZ, speed, delta)) {
        runtime.moving = false;
        runtime.nextDecisionAt = time + 1.2 + seededUnit(entity.index, runtime.autonomySequence + 31) * 2.6;
        this.playAutonomyClip(runtime, false, time);
      }
    }
    entity.object3D!.position.y = this.restingY(runtime, time);
  }

  private chooseAutonomousState(runtime: AvatarRuntime, time: number): void {
    runtime.autonomySequence += 1;
    const shouldMove = seededUnit(runtime.entity.index, runtime.autonomySequence) > 0.28;
    if (!shouldMove) {
      runtime.moving = false;
      runtime.nextDecisionAt = time + 1.4 + seededUnit(runtime.entity.index, runtime.autonomySequence + 7) * 2.8;
      this.playAutonomyClip(runtime, false, time);
      return;
    }
    const destination = this.pickDestination(runtime);
    runtime.destinationX = destination.x;
    runtime.destinationZ = destination.z;
    runtime.moving = true;
    runtime.nextDecisionAt = time + 8;
    this.playAutonomyClip(runtime, true, time);
  }

  private pickDestination(runtime: AvatarRuntime): { x: number; z: number } {
    let candidate = { x: runtime.initialX, z: runtime.initialZ };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const sequence = runtime.autonomySequence * 11 + attempt;
      candidate = {
        x: TABLE_MIN_X + 0.025 + seededUnit(runtime.entity.index, sequence) * (TABLE_MAX_X - TABLE_MIN_X - 0.05),
        z: TABLE_MIN_Z + 0.025 + seededUnit(runtime.entity.index + 17, sequence) * (TABLE_MAX_Z - TABLE_MIN_Z - 0.05),
      };
      if (!isPlayablePosition(candidate.x, candidate.z)) continue;
      const crowded = [...this.runtimes.values()].some(
        (other) =>
          other !== runtime &&
          other.entity.object3D?.visible &&
          Math.hypot(other.entity.object3D.position.x - candidate.x, other.entity.object3D.position.z - candidate.z) < 0.065,
      );
      if (!crowded) break;
    }
    return candidate;
  }

  private moveToward(
    runtime: AvatarRuntime,
    targetX: number,
    targetZ: number,
    speed: number,
    delta: number,
  ): boolean {
    const object = runtime.entity.object3D;
    if (object == null) return true;
    const dx = targetX - object.position.x;
    const dz = targetZ - object.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.008) return true;
    const step = Math.min(distance, speed * Math.min(delta, 1 / 15));
    object.position.x = clamp(object.position.x + (dx / distance) * step, TABLE_MIN_X, TABLE_MAX_X);
    object.position.z = clamp(object.position.z + (dz / distance) * step, TABLE_MIN_Z, TABLE_MAX_Z);
    const targetRotation = Math.atan2(dx, dz);
    const difference = Math.atan2(Math.sin(targetRotation - object.rotation.y), Math.cos(targetRotation - object.rotation.y));
    object.rotation.y += difference * Math.min(1, delta * 7);
    return distance <= step + 0.008;
  }

  private playAutonomyClip(runtime: AvatarRuntime, moving: boolean, time: number): void {
    const category = runtime.monster?.category;
    if (category == null) return;
    const clips = MONSTER_AUTONOMY_CLIPS[category];
    this.playClip(runtime, moving ? clips.move : clips.idle, true, time);
    runtime.entity.setValue(MonsterAvatar, 'state', MonsterStates.Autonomous);
  }

  private playFirstAvailable(runtime: AvatarRuntime, names: string[], loop: boolean, time: number): boolean {
    const name = names.find((candidate) => runtime.clips.has(candidate));
    return name == null ? false : this.playClip(runtime, name, loop, time);
  }

  private playClip(runtime: AvatarRuntime, name: string | undefined, loop: boolean, time: number): boolean {
    const mixer = runtime.mixer;
    const clip = name == null ? null : runtime.clips.get(name);
    if (mixer == null || clip == null || name == null) return false;
    if (runtime.activeClip === name && runtime.activeLoop === loop && runtime.activeAction?.isRunning()) return true;
    const previous = runtime.activeAction;
    const action = mixer.clipAction(clip);
    action.reset();
    action.enabled = true;
    action.clampWhenFinished = !loop;
    action.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
    action.fadeIn(0.12).play();
    if (previous != null && previous !== action) previous.fadeOut(0.12);
    runtime.activeAction = action;
    runtime.activeClip = name;
    runtime.activeLoop = loop;
    runtime.clipEndsAt = loop ? Number.POSITIVE_INFINITY : time + clip.duration;
    runtime.entity.setValue(MonsterAvatar, 'activeClip', name);
    return true;
  }

  private restingY(runtime: AvatarRuntime, time: number): number {
    const category = runtime.monster?.category;
    if (category === MonsterCategories.Flying) {
      return runtime.initialY + 0.06 + Math.sin(time * 2.4 + runtime.entity.index) * 0.006;
    }
    if (category === MonsterCategories.Blob) {
      return runtime.initialY + Math.sin(time * 2.1 + runtime.entity.index) * 0.002;
    }
    return runtime.initialY;
  }

  private animateFallback(entity: Entity, runtime: AvatarRuntime, delta: number, time: number): void {
    const object = entity.object3D!;
    const behavior = entity.getValue(ViewerAvatar, 'behavior');
    const elapsed = Math.max(0, time - runtime.actionStartedAt);
    object.rotation.z = 0;
    if (runtime.leftArm != null) runtime.leftArm.rotation.z = 0;
    if (runtime.rightArm != null) runtime.rightArm.rotation.z = 0;
    if (behavior === AvatarBehaviors.Run || behavior === AvatarBehaviors.Walk || behavior === AvatarBehaviors.Fly) {
      const targetX = entity.getValue(ViewerAvatar, 'targetX') ?? object.position.x;
      const targetZ = entity.getValue(ViewerAvatar, 'targetZ') ?? object.position.z;
      this.moveToward(runtime, targetX, targetZ, behavior === AvatarBehaviors.Walk ? 0.1 : 0.2, delta);
      object.position.y = runtime.initialY + Math.abs(Math.sin(elapsed * 13)) * 0.008;
    } else if (behavior === AvatarBehaviors.Wave && runtime.rightArm != null) {
      runtime.rightArm.rotation.z = -1.8 + Math.sin(elapsed * 12) * 0.35;
    } else if (behavior === AvatarBehaviors.Dance) {
      object.rotation.z = Math.sin(elapsed * 7) * 0.28;
      object.rotation.y = Math.sin(elapsed * 3.5) * 0.45;
    } else if (behavior === AvatarBehaviors.Jump) {
      object.position.y = runtime.initialY + Math.sin(Math.min(1, elapsed / 1.05) * Math.PI) * 0.09;
    } else {
      object.position.y = runtime.initialY + Math.sin(time * 2.1 + entity.index) * 0.0025;
    }
  }

  private settleOnTable(entity: Entity): void {
    const runtime = this.runtimes.get(entity);
    const object = entity.object3D;
    if (runtime == null || object == null || !object.visible) return;
    object.position.x = clamp(object.position.x, TABLE_MIN_X, TABLE_MAX_X);
    object.position.z = clamp(object.position.z, TABLE_MIN_Z, TABLE_MAX_Z);
    object.position.y = this.restingY(runtime, this.currentTime);
    object.rotation.x = 0;
    object.rotation.z = 0;
  }

  private applyColor(root: Object3D, colorHex: string): void {
    const color = new Color(colorHex);
    root.traverse((child) => {
      if (child instanceof Mesh && child.material instanceof MeshStandardMaterial && child.material.name === 'AvatarTint') {
        child.material.color.copy(color);
      }
    });
  }

  private setLabel(runtime: AvatarRuntime, displayName: string): void {
    if (runtime.label != null && runtime.labelText === displayName) return;
    this.removeLabel(runtime);
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    if (context == null || runtime.entity.object3D == null) return;
    context.fillStyle = 'rgba(8, 20, 25, 0.88)';
    context.beginPath();
    context.roundRect(4, 4, 504, 88, 28);
    context.fill();
    context.fillStyle = '#FFFFFF';
    context.font = '600 48px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(displayName, 256, 49, 470);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    const material = new SpriteMaterial({ map: texture, transparent: true });
    material.depthTest = false;
    const label = new Sprite(material);
    label.name = 'Viewer Name Label';
    const hover = runtime.monster?.category === MonsterCategories.Flying ? 0.06 : 0;
    label.position.set(0, (runtime.monster?.targetHeight ?? 0.18) + hover + 0.028, 0);
    label.scale.set(0.17, 0.032, 1);
    label.renderOrder = 20;
    runtime.entity.object3D.add(label);
    runtime.label = label;
    runtime.labelText = displayName;
  }

  private removeLabel(runtime: AvatarRuntime): void {
    const label = runtime.label;
    if (label == null) return;
    label.removeFromParent();
    label.material.map?.dispose();
    label.material.dispose();
    runtime.label = null;
    runtime.labelText = '';
  }

  private showBubble(userId: string, text: string, time: number): void {
    const entity = this.userEntities.get(userId);
    const runtime = entity == null ? null : this.runtimes.get(entity);
    if (
      entity == null ||
      runtime == null ||
      entity.object3D == null ||
      (!entity.object3D.visible && runtime.hitRespawnAt <= 0) ||
      entity.getValue(ViewerAvatar, 'behavior') === AvatarBehaviors.Leaving
    ) {
      return;
    }
    this.removeBubble(runtime);
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 320;
    const context = canvas.getContext('2d');
    if (context == null) return;

    context.shadowColor = 'rgba(18, 31, 38, 0.2)';
    context.shadowBlur = 12;
    context.shadowOffsetY = 8;
    context.fillStyle = '#FFF8E8';
    context.strokeStyle = '#293340';
    context.lineWidth = 8;
    context.beginPath();
    context.roundRect(20, 16, 600, 238, 48);
    context.moveTo(284, 250);
    context.lineTo(320, 302);
    context.lineTo(356, 250);
    context.closePath();
    context.fill();
    context.stroke();
    context.shadowColor = 'transparent';

    context.fillStyle = '#293340';
    context.font = '600 36px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const lines = wrapBubbleText(context, text, 530, 3);
    const lineHeight = 52;
    const startY = 134 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, index) => context.fillText(line, 320, startY + index * lineHeight));

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    const material = new SpriteMaterial({ map: texture, transparent: true, opacity: 0 });
    material.depthTest = false;
    const bubble = new Sprite(material);
    bubble.name = 'Viewer Speech Bubble';
    const hover = runtime.monster?.category === MonsterCategories.Flying ? 0.06 : 0;
    bubble.position.set(0, (runtime.monster?.targetHeight ?? 0.18) + hover + 0.115, 0);
    bubble.scale.set(0.001, 0.001, 1);
    bubble.renderOrder = 21;
    entity.object3D.add(bubble);
    runtime.bubble = bubble;
    runtime.bubbleText = text;
    runtime.bubbleShownAt = time;
    runtime.bubbleExpiresAt = time + 5;
  }

  private updateBubble(runtime: AvatarRuntime, time: number): void {
    const bubble = runtime.bubble;
    if (bubble == null) return;
    if (time >= runtime.bubbleExpiresAt) {
      this.removeBubble(runtime);
      return;
    }
    const popProgress = clamp((time - runtime.bubbleShownAt) / 0.16, 0, 1);
    const fadeProgress = clamp((runtime.bubbleExpiresAt - time) / 0.45, 0, 1);
    const scale = 0.82 + 0.18 * elasticOut(popProgress);
    bubble.scale.set(0.28 * scale, 0.14 * scale, 1);
    bubble.material.opacity = Math.min(popProgress, fadeProgress);
  }

  private removeBubble(runtime: AvatarRuntime): void {
    const bubble = runtime.bubble;
    if (bubble == null) return;
    bubble.removeFromParent();
    bubble.material.map?.dispose();
    bubble.material.dispose();
    runtime.bubble = null;
    runtime.bubbleText = '';
    runtime.bubbleShownAt = 0;
    runtime.bubbleExpiresAt = 0;
  }

  private setSocketStatus(status: SocketStatus): void {
    this.backendConnected = status === 'connected';
    if (!this.backendConnected) {
      this.twitchConnected = false;
      for (const runtime of this.runtimes.values()) this.removeBubble(runtime);
    }
    this.renderStatus();
  }

  private renderStatus(): void {
    if (this.statusElement == null) return;
    this.statusElement.dataset.state = this.twitchConnected ? 'ready' : this.backendConnected ? 'waiting' : 'offline';
    this.statusElement.textContent = this.twitchConnected
      ? `Twitch connected: ${this.broadcasterLogin ?? 'streamer'}`
      : this.backendConnected
        ? 'ChatIRL backend connected — authorize Twitch'
        : 'ChatIRL backend offline';
  }
}

function wrapBubbleText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const characters = [...text];
  const lines: string[] = [];
  let line = '';
  for (let index = 0; index < characters.length; index += 1) {
    const candidate = line + characters[index];
    if (line === '' || context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (lines.length === maxLines - 1) {
      let finalLine = (line + characters.slice(index).join('')).trim();
      while (finalLine && context.measureText(`${finalLine}…`).width > maxWidth) {
        finalLine = [...finalLine].slice(0, -1).join('');
      }
      lines.push(`${finalLine.trimEnd()}…`);
      return lines;
    }
    lines.push(line.trimEnd());
    line = characters[index].trimStart();
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isPlayablePosition(x: number, z: number): boolean {
  const insideTerrain = (x / TERRAIN_RADIUS_X) ** 2 + (z / TERRAIN_RADIUS_Z) ** 2 <= 1;
  if (!insideTerrain) return false;
  return !TERRAIN_OBSTACLES.some(
    (obstacle) => Math.hypot(x - obstacle.x, z - obstacle.z) < obstacle.radius,
  );
}

function seededUnit(first: number, second: number): number {
  let value = Math.imul(first + 1, 0x9e3779b1) ^ Math.imul(second + 1, 0x85ebca6b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

function elasticOut(value: number): number {
  const progress = clamp(value, 0, 1);
  if (progress === 0 || progress === 1) return progress;
  return 2 ** (-10 * progress) * Math.sin((progress * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}
