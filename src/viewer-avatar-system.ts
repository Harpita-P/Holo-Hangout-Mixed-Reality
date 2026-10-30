import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  Box3,
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  createSystem,
  type Entity,
  Grabbed,
  GrabSystem,
  Group,
  LinearFilter,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
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
  type CommunityLeaderboardEntry,
  type ReactionType,
  type ServerMessage,
} from '../shared/protocol.js';
import { ChatIRLSocket, type SocketStatus } from './chatirl-socket.js';
import { ShoutoutTracker } from '../shared/shoutout-tracker.js';
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
  labelIsBot: boolean;
  bubble: Sprite | null;
  bubbleText: string;
  bubbleShownAt: number;
  bubbleExpiresAt: number;
  impact: PaintImpact | null;
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

interface PaintImpact {
  root: Group;
  core: Mesh;
  rings: Mesh[];
  particles: Mesh[];
}

interface ReactionEffect {
  root: Group;
  origin: Vector3;
  direction: Vector3;
  startedAt: number;
  materials: MeshBasicMaterial[];
  label: Sprite;
}

interface WelcomeNotice {
  sprite: Sprite;
  shownAt: number;
  expiresAt: number;
}

interface ShoutoutEffect {
  root: Group;
  entity: Entity | null;
  origin: Vector3;
  startedAt: number;
  halo: Mesh[];
  spotlight: Mesh;
  stars: Mesh[];
  materials: MeshBasicMaterial[];
  label: Sprite;
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
const impactCoreGeometry = new SphereGeometry(0.5, 12, 8);
const impactRingGeometry = new TorusGeometry(0.5, 0.055, 6, 24);
const impactParticleGeometry = new SphereGeometry(0.09, 8, 6);
const reactionSphereGeometry = new SphereGeometry(0.5, 10, 7);
const reactionBoxGeometry = new BoxGeometry(1, 1, 1, 1, 1, 1);
const reactionConeGeometry = new ConeGeometry(0.5, 1, 8, 1);
const shoutoutStarGeometry = new OctahedronGeometry(0.5, 0);
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
  private communityEntries: CommunityLeaderboardEntry[] = [];
  private leaderboardPanel: Sprite | null = null;
  private leaderboardCanvas: HTMLCanvasElement | null = null;
  private bannerPanel: Sprite | null = null;
  private bannerCanvas: HTMLCanvasElement | null = null;
  private readonly reactionEffects: ReactionEffect[] = [];
  private readonly shoutoutTracker = new ShoutoutTracker();
  private readonly shoutoutEffects: ShoutoutEffect[] = [];
  private welcomeNotice: WelcomeNotice | null = null;
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
    this.createCommunityPanels();

    const offHeld = this.queries.held.subscribe('qualify', (entity) => {
      const runtime = this.runtimes.get(entity);
      if (runtime != null) {
        runtime.held = true;
        entity.setValue(MonsterAvatar, 'state', MonsterStates.Held);
        this.playFirstAvailable(runtime, ['HitReact', 'HitRecieve'], false, this.currentTime);
      }
      const userId = entity.getValue(ViewerAvatar, 'userId');
      if (userId && runtime != null) {
        this.shoutoutTracker.begin(userId, runtime.labelIsBot, this.currentTime);
      }
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
      if (userId) this.shoutoutTracker.release(userId);
      if (userId) this.socket?.send({ type: 'avatar.held', userId, held: false });
    });
    this.cleanupFuncs.push(offHeld, offReleased);

    this.socket = new ChatIRLSocket(
      (message) => this.messageQueue.push(message),
      (status) => this.setSocketStatus(status),
    );
    this.cleanupFuncs.push(() => {
      this.socket.close();
      this.removeWelcomeNotice();
      for (const effect of [...this.reactionEffects]) this.removeReactionEffect(effect);
      for (const effect of [...this.shoutoutEffects]) this.removeShoutoutEffect(effect);
      this.shoutoutTracker.clear();
    });
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
    this.updateReactionEffects(time);
    this.updateWelcomeNotice(time);
    this.updateShoutoutEffects(time);
    for (const userId of this.shoutoutTracker.update(time)) {
      this.createShoutoutCelebration(userId, time);
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
      labelIsBot: false,
      bubble: null,
      bubbleText: '',
      bubbleShownAt: 0,
      bubbleExpiresAt: 0,
      impact: null,
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
      case 'viewer.welcome':
        this.showWelcomeNotice(message.displayName, time);
        break;
      case 'avatar.reaction':
        this.showReaction(message.userId, message.reaction, time);
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
        this.renderWorldBanner();
        break;
      case 'community.leaderboard':
        this.communityEntries = message.entries;
        this.renderLeaderboard();
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
      const spawn = this.pickSpawnPosition(runtime);
      object.position.set(spawn.x, this.restingY(runtime, time), spawn.z);
      runtime.destinationX = spawn.x;
      runtime.destinationZ = spawn.z;
      object.rotation.set(0, 0, 0);
      object.scale.setScalar(0.001);
      runtime.spawnEndsAt = time + 0.35;
      runtime.nextDecisionAt = time + 0.65 + seededUnit(entity.index, 1) * 1.2;
    }
    object.visible = runtime.hitRespawnAt <= 0;
    runtime.actionStartedAt = time;
    runtime.leavingAt = 0;
    this.applyColor(object, participant.colorHex);
    this.setLabel(runtime, participant.displayName, participant.isBot);
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
    this.shoutoutTracker.cancel(userId);
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
    this.shoutoutTracker.cancel(userId);
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
    const userId = entity.getValue(ViewerAvatar, 'userId');
    if (userId) this.shoutoutTracker.cancel(userId);
    if (this.queries.held.entities.has(entity)) this.grabSystem?.forceRelease(entity);
    runtime.hitOriginX = object.position.x;
    runtime.hitOriginZ = object.position.z;
    runtime.hitStartedAt = time;
    runtime.hitRespawnAt = time + 0.58;
    runtime.moving = false;
    this.removePaintSplatter(runtime);
    runtime.impact = this.createPaintImpact(runtime);
    object.visible = false;
  }

  private createPaintImpact(runtime: AvatarRuntime): PaintImpact | null {
    const object = runtime.entity.object3D;
    const parent = object?.parent;
    if (object == null || parent == null) return null;
    const root = new Group();
    root.name = 'Paintball Pink Energy Impact';
    root.position.copy(object.position);
    root.position.y += (runtime.monster?.targetHeight ?? 0.18) * 0.55;
    root.scale.setScalar(0.001);
    const core = new Mesh(
      impactCoreGeometry,
      new MeshBasicMaterial({ color: '#FF2D9B', transparent: true, opacity: 1, depthTest: false }),
    );
    core.renderOrder = 31;
    root.add(core);
    const rings = [0, Math.PI / 2].map((rotation) => {
      const ring = new Mesh(
        impactRingGeometry,
        new MeshBasicMaterial({ color: '#FF8CD1', transparent: true, opacity: 1, depthTest: false }),
      );
      ring.rotation.x = rotation;
      ring.renderOrder = 30;
      root.add(ring);
      return ring;
    });
    const particles = Array.from({ length: 7 }, (_, index) => {
      const particle = new Mesh(
        impactParticleGeometry,
        new MeshBasicMaterial({ color: index % 2 === 0 ? '#FF3FAD' : '#FFD0EC', transparent: true, opacity: 1, depthTest: false }),
      );
      particle.userData.impactAngle = (index / 7) * Math.PI * 2;
      particle.userData.impactLift = index % 3 === 0 ? 0.55 : index % 3 === 1 ? 0.05 : -0.3;
      particle.renderOrder = 32;
      root.add(particle);
      return particle;
    });
    parent.add(root);
    return { root, core, rings, particles };
  }

  private updatePaintballHit(runtime: AvatarRuntime, time: number): void {
    const elapsed = Math.max(0, time - runtime.hitStartedAt);
    if (runtime.impact != null) {
      const pop = elasticOut(clamp(elapsed / 0.14, 0, 1));
      const fade = 1 - clamp((elapsed - 0.28) / 0.26, 0, 1);
      runtime.impact.root.scale.setScalar(0.08 + pop * 0.26);
      runtime.impact.core.scale.setScalar(1 - clamp(elapsed / 0.5, 0, 0.7));
      (runtime.impact.core.material as MeshBasicMaterial).opacity = fade;
      runtime.impact.rings.forEach((ring, index) => {
        ring.scale.setScalar(0.65 + elapsed * (0.7 + index * 0.15));
        ring.rotation.z += 0.08 + index * 0.025;
        (ring.material as MeshBasicMaterial).opacity = fade * 0.82;
      });
      runtime.impact.particles.forEach((particle) => {
        const distance = 0.18 + elapsed * 0.45;
        const angle = particle.userData.impactAngle as number;
        particle.position.set(
          Math.cos(angle) * distance,
          (particle.userData.impactLift as number) * distance,
          Math.sin(angle) * distance,
        );
        (particle.material as MeshBasicMaterial).opacity = fade;
      });
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
    const impact = runtime.impact;
    if (impact == null) return;
    impact.root.removeFromParent();
    impact.root.traverse((child) => {
      if (child instanceof Mesh && child.material instanceof MeshBasicMaterial) child.material.dispose();
    });
    runtime.impact = null;
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
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const sequence = runtime.autonomySequence * 11 + attempt;
      candidate = {
        x: TABLE_MIN_X + 0.012 + seededUnit(runtime.entity.index, sequence) * (TABLE_MAX_X - TABLE_MIN_X - 0.024),
        z: TABLE_MIN_Z + 0.012 + seededUnit(runtime.entity.index + 17, sequence) * (TABLE_MAX_Z - TABLE_MIN_Z - 0.024),
      };
      if (!isPlayablePosition(candidate.x, candidate.z)) continue;
      const crowded = [...this.runtimes.values()].some(
        (other) =>
          other !== runtime &&
          other.entity.object3D?.visible &&
          Math.hypot(other.entity.object3D.position.x - candidate.x, other.entity.object3D.position.z - candidate.z) < 0.1,
      );
      if (!crowded) break;
    }
    return candidate;
  }

  private pickSpawnPosition(runtime: AvatarRuntime): { x: number; z: number } {
    let fallback = { x: runtime.initialX, z: runtime.initialZ };
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const sequence = runtime.entity.index * 37 + attempt + 1;
      const candidate = {
        x: TABLE_MIN_X + 0.018 + seededUnit(runtime.entity.index + 41, sequence) * (TABLE_MAX_X - TABLE_MIN_X - 0.036),
        z: TABLE_MIN_Z + 0.018 + seededUnit(runtime.entity.index + 73, sequence) * (TABLE_MAX_Z - TABLE_MIN_Z - 0.036),
      };
      if (!isPlayablePosition(candidate.x, candidate.z)) continue;
      fallback = candidate;
      const crowded = [...this.runtimes.values()].some(
        (other) =>
          other !== runtime &&
          other.entity.object3D?.visible &&
          Math.hypot(
            other.entity.object3D.position.x - candidate.x,
            other.entity.object3D.position.z - candidate.z,
          ) < 0.14,
      );
      if (!crowded) return candidate;
    }
    return fallback;
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

  private setLabel(runtime: AvatarRuntime, displayName: string, isBot: boolean): void {
    if (
      runtime.label != null &&
      runtime.labelText === displayName &&
      runtime.labelIsBot === isBot
    ) return;
    this.removeLabel(runtime);
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    if (context == null || runtime.entity.object3D == null) return;
    context.fillStyle = isBot ? 'rgba(27, 103, 101, 0.9)' : 'rgba(8, 20, 25, 0.88)';
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
    runtime.labelIsBot = isBot;
  }

  private removeLabel(runtime: AvatarRuntime): void {
    const label = runtime.label;
    if (label == null) return;
    label.removeFromParent();
    label.material.map?.dispose();
    label.material.dispose();
    runtime.label = null;
    runtime.labelText = '';
    runtime.labelIsBot = false;
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
    context.font = '600 40px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const lines = wrapBubbleText(context, text, 530, 3);
    const lineHeight = 56;
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

  private showWelcomeNotice(displayName: string, time: number): void {
    const parent = this.slots[0]?.object3D?.parent;
    if (parent == null) return;
    this.removeWelcomeNotice();
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    if (context == null) return;
    context.shadowColor = 'rgba(55, 44, 36, 0.2)';
    context.shadowBlur = 18;
    context.fillStyle = 'rgba(255, 249, 240, 0.98)';
    context.beginPath();
    context.roundRect(18, 18, 732, 144, 48);
    context.fill();
    context.shadowColor = 'transparent';
    context.strokeStyle = '#E5D5C8';
    context.lineWidth = 6;
    context.stroke();

    let fontSize = 56;
    context.font = `800 ${fontSize}px system-ui, sans-serif`;
    const prefix = 'Welcome, ';
    const suffix = '!';
    let totalWidth = context.measureText(`${prefix}${displayName}${suffix}`).width;
    if (totalWidth > 680) fontSize = Math.max(38, fontSize * (680 / totalWidth));
    context.font = `800 ${fontSize}px system-ui, sans-serif`;
    const prefixWidth = context.measureText(prefix).width;
    const nameWidth = context.measureText(displayName).width;
    const suffixWidth = context.measureText(suffix).width;
    totalWidth = prefixWidth + nameWidth + suffixWidth;
    let x = (canvas.width - totalWidth) / 2;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillStyle = '#2C3434';
    context.fillText(prefix, x, 90);
    x += prefixWidth;
    context.fillStyle = '#C94F78';
    context.fillText(displayName, x, 90);
    x += nameWidth;
    context.fillStyle = '#2C3434';
    context.fillText(suffix, x, 90);

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    const sprite = new Sprite(
      new SpriteMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0 }),
    );
    sprite.name = 'Viewer Join Welcome';
    sprite.position.set(0, 0.43, -0.08);
    sprite.scale.set(0.001, 0.001, 1);
    sprite.renderOrder = 24;
    parent.add(sprite);
    this.welcomeNotice = { sprite, shownAt: time, expiresAt: time + 3.6 };
  }

  private updateWelcomeNotice(time: number): void {
    const notice = this.welcomeNotice;
    if (notice == null) return;
    if (time >= notice.expiresAt) {
      this.removeWelcomeNotice();
      return;
    }
    const appear = clamp((time - notice.shownAt) / 0.2, 0, 1);
    const fade = clamp((notice.expiresAt - time) / 0.55, 0, 1);
    const scale = 0.85 + elasticOut(appear) * 0.15;
    notice.sprite.scale.set(0.44 * scale, 0.103 * scale, 1);
    notice.sprite.material.opacity = Math.min(appear, fade);
  }

  private removeWelcomeNotice(): void {
    const notice = this.welcomeNotice;
    if (notice == null) return;
    notice.sprite.removeFromParent();
    notice.sprite.material.map?.dispose();
    notice.sprite.material.dispose();
    this.welcomeNotice = null;
  }

  private showReaction(userId: string, reaction: ReactionType, time: number): void {
    const entity = this.userEntities.get(userId);
    const runtime = entity == null ? null : this.runtimes.get(entity);
    const object = entity?.object3D;
    if (entity == null || runtime == null || object == null || !object.visible) return;
    while (this.reactionEffects.length >= 12) {
      const oldest = this.reactionEffects[0];
      if (oldest != null) this.removeReactionEffect(oldest);
    }
    object.updateWorldMatrix(true, false);
    const height = runtime.monster?.targetHeight ?? 0.14;
    const origin = object.localToWorld(new Vector3(0.08, height * 0.78 + 0.07, 0));
    const root = new Group();
    root.name = `Viewer Reaction — ${reaction}`;
    root.position.copy(origin);
    root.scale.setScalar(0.001);
    const materials: MeshBasicMaterial[] = [];
    const material = (color: string): MeshBasicMaterial => {
      const value = new MeshBasicMaterial({ color, transparent: true, depthTest: true });
      materials.push(value);
      return value;
    };
    const add = (
      geometry: SphereGeometry | BoxGeometry | ConeGeometry,
      color: string,
      position: [number, number, number],
      scale: [number, number, number],
      rotationZ = 0,
    ): void => {
      const mesh = new Mesh(geometry, material(color));
      mesh.position.set(...position);
      mesh.scale.set(...scale);
      mesh.rotation.z = rotationZ;
      mesh.renderOrder = 22;
      root.add(mesh);
    };
    if (reaction === 'support') {
      add(reactionSphereGeometry, '#FF6598', [-0.028, 0.026, 0], [0.07, 0.07, 0.05]);
      add(reactionSphereGeometry, '#FF6598', [0.028, 0.026, 0], [0.07, 0.07, 0.05]);
      add(reactionConeGeometry, '#F04F86', [0, -0.035, 0], [0.11, 0.13, 0.08], Math.PI);
    } else if (reaction === 'like') {
      add(reactionBoxGeometry, '#FFD36A', [0, 0, 0], [0.1, 0.11, 0.045]);
      add(reactionBoxGeometry, '#FFE39A', [0.075, 0.055, 0], [0.09, 0.035, 0.045], -0.55);
      add(reactionBoxGeometry, '#FFD36A', [-0.058, 0.015, 0], [0.035, 0.12, 0.045]);
    } else {
      add(reactionConeGeometry, '#FF6B36', [0, 0, 0], [0.12, 0.18, 0.09]);
      add(reactionConeGeometry, '#FFB52E', [0.025, -0.015, 0.01], [0.075, 0.12, 0.06], -0.18);
      add(reactionConeGeometry, '#FFF0A0', [-0.018, -0.03, 0.02], [0.038, 0.075, 0.035], 0.15);
    }
    const label = this.createReactionLabel(entity.getValue(ViewerAvatar, 'displayName') ?? 'viewer');
    label.position.set(0, -0.14, 0);
    root.add(label);
    this.world.scene.add(root);
    const angle = (entity.index * 1.73) % (Math.PI * 2);
    this.reactionEffects.push({
      root,
      origin,
      direction: new Vector3(Math.cos(angle), 0, Math.sin(angle)),
      startedAt: time,
      materials,
      label,
    });
  }

  private createReactionLabel(displayName: string): Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'rgba(24, 31, 33, 0.9)';
    context.beginPath();
    context.roundRect(8, 8, 496, 80, 28);
    context.fill();
    context.fillStyle = '#FFFFFF';
    context.font = '700 43px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(displayName, 256, 49, 460);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    const sprite = new Sprite(
      new SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
    );
    sprite.scale.set(0.2, 0.038, 1);
    sprite.renderOrder = 23;
    return sprite;
  }

  private updateReactionEffects(time: number): void {
    for (const effect of [...this.reactionEffects]) {
      const elapsed = time - effect.startedAt;
      if (elapsed >= 3.6) {
        this.removeReactionEffect(effect);
        continue;
      }
      const appear = clamp(elapsed / 0.22, 0, 1);
      const fade = elapsed < 2.55 ? 1 : clamp((3.6 - elapsed) / 1.05, 0, 1);
      const progress = clamp(elapsed / 3.6, 0, 1);
      effect.root.position.copy(effect.origin).addScaledVector(effect.direction, progress * 0.08);
      effect.root.position.y += progress * 0.16;
      effect.root.rotation.y = elapsed * 0.55;
      effect.root.rotation.z = Math.sin(elapsed * 2.1) * 0.08;
      effect.root.scale.setScalar((0.86 + elasticOut(appear) * 0.14) * fade);
      for (const value of effect.materials) value.opacity = fade;
      effect.label.material.opacity = fade;
    }
  }

  private removeReactionEffect(effect: ReactionEffect): void {
    const index = this.reactionEffects.indexOf(effect);
    if (index >= 0) this.reactionEffects.splice(index, 1);
    effect.root.removeFromParent();
    for (const material of effect.materials) material.dispose();
    effect.label.material.map?.dispose();
    effect.label.material.dispose();
  }

  private createShoutoutCelebration(userId: string, time: number): void {
    const entity = this.userEntities.get(userId);
    const runtime = entity == null ? null : this.runtimes.get(entity);
    const object = entity?.object3D;
    if (
      entity == null ||
      runtime == null ||
      runtime.labelIsBot ||
      object == null ||
      !object.visible ||
      !this.queries.held.entities.has(entity)
    ) return;
    while (this.shoutoutEffects.length >= 5) {
      const oldest = this.shoutoutEffects[0];
      if (oldest != null) this.removeShoutoutEffect(oldest);
    }
    object.updateWorldMatrix(true, false);
    const height = runtime.monster?.targetHeight ?? 0.14;
    const origin = object.localToWorld(new Vector3(0, height * 0.58 + 0.045, 0));
    const root = new Group();
    root.name = `Community Shoutout — ${userId}`;
    root.position.copy(origin);
    root.quaternion.copy(this.world.player.head.getWorldQuaternion(new Quaternion()));
    root.scale.setScalar(0.001);
    const materials: MeshBasicMaterial[] = [];
    const makeMaterial = (color: string, opacity: number): MeshBasicMaterial => {
      const material = new MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthTest: false,
      });
      materials.push(material);
      return material;
    };

    const halo = [0, Math.PI / 2].map((rotationY, index) => {
      const ring = new Mesh(
        impactRingGeometry,
        makeMaterial(index === 0 ? '#FFD96A' : '#FFF0AD', 0),
      );
      ring.name = 'Shoutout Golden Halo';
      ring.rotation.y = rotationY;
      ring.scale.setScalar(0.18);
      ring.renderOrder = 35;
      root.add(ring);
      return ring;
    });
    const spotlight = new Mesh(
      reactionConeGeometry,
      makeMaterial('#FFE79A', 0),
    );
    spotlight.name = 'Shoutout Soft Spotlight';
    spotlight.position.y = 0.06;
    spotlight.scale.set(0.19, 0.3, 0.12);
    spotlight.rotation.z = Math.PI;
    spotlight.renderOrder = 33;
    root.add(spotlight);

    const stars = Array.from({ length: 15 }, (_, index) => {
      const orbit = index >= 10;
      const star = new Mesh(
        shoutoutStarGeometry,
        makeMaterial(index % 3 === 0 ? '#FFF2A8' : '#FFD35A', 0),
      );
      star.name = orbit ? 'Shoutout Orbit Star' : 'Shoutout Burst Star';
      star.userData.shoutoutAngle = (index / (orbit ? 5 : 10)) * Math.PI * 2;
      star.userData.shoutoutOrbit = orbit;
      star.userData.shoutoutRadius = 0.14 + (index % 3) * 0.025;
      star.scale.setScalar(orbit ? 0.032 : 0.038);
      star.renderOrder = 36;
      root.add(star);
      return star;
    });
    const displayName = entity.getValue(ViewerAvatar, 'displayName') ?? 'viewer';
    const label = this.createShoutoutLabel(displayName);
    label.position.set(0, 0.26, 0);
    root.add(label);
    this.world.scene.add(root);
    this.shoutoutEffects.push({
      root,
      entity,
      origin,
      startedAt: time,
      halo,
      spotlight,
      stars,
      materials,
      label,
    });
  }

  private createShoutoutLabel(displayName: string): Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 320;
    const context = canvas.getContext('2d')!;
    context.shadowColor = 'rgba(85, 53, 8, 0.38)';
    context.shadowBlur = 22;
    context.fillStyle = 'rgba(56, 43, 24, 0.84)';
    context.beginPath();
    context.roundRect(24, 24, 976, 272, 74);
    context.fill();
    context.shadowColor = 'transparent';
    context.strokeStyle = '#FFD76A';
    context.lineWidth = 8;
    context.stroke();
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#FFF9E9';
    context.font = '800 54px system-ui, sans-serif';
    context.fillText('Shoutout to', 512, 104);
    let fontSize = 84;
    context.font = `900 ${fontSize}px system-ui, sans-serif`;
    const desiredWidth = context.measureText(`${displayName}!`).width;
    if (desiredWidth > 900) fontSize = Math.max(48, fontSize * (900 / desiredWidth));
    context.font = `900 ${fontSize}px system-ui, sans-serif`;
    context.fillStyle = '#FF789E';
    context.fillText(`${displayName}!`, 512, 212, 900);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    const sprite = new Sprite(
      new SpriteMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0 }),
    );
    sprite.name = 'Community Shoutout Text';
    sprite.scale.set(0.5, 0.156, 1);
    sprite.renderOrder = 38;
    return sprite;
  }

  private updateShoutoutEffects(time: number): void {
    for (const effect of [...this.shoutoutEffects]) {
      const elapsed = time - effect.startedAt;
      if (elapsed >= 3.8) {
        this.removeShoutoutEffect(effect);
        continue;
      }
      if (
        effect.entity != null &&
        effect.entity.object3D?.visible &&
        this.queries.held.entities.has(effect.entity)
      ) {
        const runtime = this.runtimes.get(effect.entity);
        const height = runtime?.monster?.targetHeight ?? 0.14;
        effect.entity.object3D.updateWorldMatrix(true, false);
        effect.entity.object3D.localToWorld(effect.origin.set(0, height * 0.58 + 0.045, 0));
      } else {
        effect.entity = null;
      }
      effect.root.position.copy(effect.origin);
      const appear = clamp(elapsed / 0.28, 0, 1);
      const burst = elasticOut(clamp(elapsed / 0.46, 0, 1));
      const fade = elapsed < 2.7 ? 1 : clamp((3.8 - elapsed) / 1.1, 0, 1);
      effect.root.scale.setScalar((0.84 + 0.16 * elasticOut(appear)) * fade);
      effect.halo.forEach((ring, index) => {
        ring.scale.setScalar(0.16 + burst * (0.17 + index * 0.035));
        ring.rotation.z = elapsed * (index === 0 ? 0.42 : -0.34);
        (ring.material as MeshBasicMaterial).opacity = fade * (index === 0 ? 0.62 : 0.38);
      });
      (effect.spotlight.material as MeshBasicMaterial).opacity = fade * 0.14;
      effect.stars.forEach((star, index) => {
        const angle = (star.userData.shoutoutAngle as number) +
          ((star.userData.shoutoutOrbit as boolean) ? elapsed * 0.7 : 0);
        const orbit = star.userData.shoutoutOrbit as boolean;
        const radius = orbit
          ? (star.userData.shoutoutRadius as number)
          : burst * (star.userData.shoutoutRadius as number);
        star.position.set(
          Math.cos(angle) * radius,
          Math.sin(angle) * radius * 0.72 + (orbit ? elapsed * 0.018 : 0),
          orbit ? Math.sin(angle * 1.7) * 0.035 : (index % 2 === 0 ? 0.018 : -0.018),
        );
        star.rotation.x = elapsed * (1.1 + index * 0.04);
        star.rotation.y = elapsed * (0.9 + index * 0.03);
        (star.material as MeshBasicMaterial).opacity = fade;
      });
      effect.label.material.opacity = Math.min(appear, fade);
      const labelScale = 0.9 + 0.1 * elasticOut(appear);
      effect.label.scale.set(0.5 * labelScale, 0.156 * labelScale, 1);
    }
  }

  private removeShoutoutEffect(effect: ShoutoutEffect): void {
    const index = this.shoutoutEffects.indexOf(effect);
    if (index >= 0) this.shoutoutEffects.splice(index, 1);
    effect.root.removeFromParent();
    for (const material of effect.materials) material.dispose();
    effect.label.material.map?.dispose();
    effect.label.material.dispose();
  }

  private createCommunityPanels(): void {
    const parent = this.slots[0]?.object3D?.parent;
    if (parent == null) return;

    this.leaderboardCanvas = document.createElement('canvas');
    this.leaderboardCanvas.width = 640;
    this.leaderboardCanvas.height = 900;
    this.leaderboardPanel = this.createWorldPanel(
      this.leaderboardCanvas,
      'Top Active Community Members',
      new Vector3(0.61, 0.32, -0.37),
      new Vector3(0.31, 0.435, 1),
    );
    parent.add(this.leaderboardPanel);

    this.bannerCanvas = document.createElement('canvas');
    this.bannerCanvas.width = 1024;
    this.bannerCanvas.height = 256;
    this.bannerPanel = this.createWorldPanel(
      this.bannerCanvas,
      'Streamer World Banner',
      new Vector3(0, 0.6, -0.55),
      new Vector3(0.7, 0.175, 1),
    );
    parent.add(this.bannerPanel);
    this.renderLeaderboard();
    this.renderWorldBanner();
    this.cleanupFuncs.push(() => {
      for (const panel of [this.leaderboardPanel, this.bannerPanel]) {
        panel?.removeFromParent();
        panel?.material.map?.dispose();
        panel?.material.dispose();
      }
    });
  }

  private createWorldPanel(
    canvas: HTMLCanvasElement,
    name: string,
    position: Vector3,
    scale: Vector3,
  ): Sprite {
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const panel = new Sprite(material);
    panel.name = name;
    panel.position.copy(position);
    panel.scale.copy(scale);
    panel.renderOrder = 18;
    return panel;
  }

  private renderLeaderboard(): void {
    const canvas = this.leaderboardCanvas;
    const panel = this.leaderboardPanel;
    const context = canvas?.getContext('2d');
    if (canvas == null || panel == null || context == null) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.shadowColor = 'rgba(91, 49, 18, 0.18)';
    context.shadowBlur = 24;
    context.fillStyle = 'rgba(255, 249, 242, 0.98)';
    context.beginPath();
    context.roundRect(24, 24, 592, 852, 52);
    context.fill();
    context.shadowColor = 'transparent';
    context.strokeStyle = '#EAD6C1';
    context.lineWidth = 7;
    context.stroke();

    // Lightweight trophy mark drawn directly into the existing canvas texture.
    context.fillStyle = '#F4B56A';
    context.beginPath();
    context.roundRect(281, 62, 78, 66, 18);
    context.fill();
    context.strokeStyle = '#B85C18';
    context.lineWidth = 8;
    context.stroke();
    context.beginPath();
    context.arc(279, 91, 25, Math.PI * 0.5, Math.PI * 1.5);
    context.arc(361, 91, 25, -Math.PI * 0.5, Math.PI * 0.5);
    context.stroke();
    context.fillStyle = '#B85C18';
    context.fillRect(312, 126, 16, 25);
    context.beginPath();
    context.roundRect(287, 148, 66, 15, 7);
    context.fill();

    context.textAlign = 'center';
    context.fillStyle = '#38271C';
    context.font = '700 31px system-ui, sans-serif';
    context.fillText('TOP ACTIVE', 320, 212);
    context.fillStyle = '#B85C18';
    context.font = '900 54px system-ui, sans-serif';
    context.fillText('COMMUNITY', 320, 269);
    context.fillStyle = '#38271C';
    context.font = '700 30px system-ui, sans-serif';
    context.fillText('MEMBERS', 320, 310);

    if (this.communityEntries.length === 0) {
      context.fillStyle = '#8B6D58';
      context.font = '600 31px system-ui, sans-serif';
      context.fillText('Waiting for the community…', 320, 560, 500);
    } else {
      this.communityEntries.slice(0, 3).forEach((entry, index) => {
        const y = 350 + index * 158;
        context.fillStyle = index === 0 ? '#FCE4C4' : '#FFF1DF';
        context.beginPath();
        context.roundRect(index === 0 ? 53 : 65, y, index === 0 ? 534 : 510, index === 0 ? 126 : 112, 30);
        context.fill();
        if (index === 0) {
          context.strokeStyle = '#B85C18';
          context.lineWidth = 5;
          context.stroke();
        }
        context.textAlign = 'left';
        context.fillStyle = '#B85C18';
        context.font = '800 39px system-ui, sans-serif';
        context.fillText(`${index + 1}`, 88, y + (index === 0 ? 78 : 70));
        context.fillStyle = '#38271C';
        context.font = `${index === 0 ? 800 : 700} ${index === 0 ? 37 : 34}px system-ui, sans-serif`;
        context.fillText(entry.displayName, 145, y + (index === 0 ? 76 : 68), 310);
        context.textAlign = 'right';
        context.fillStyle = '#B85C18';
        context.font = '800 35px system-ui, sans-serif';
        context.fillText(String(entry.score), 545, y + (index === 0 ? 76 : 68));
      });
    }
    if (panel.material.map != null) panel.material.map.needsUpdate = true;
  }

  private renderWorldBanner(): void {
    const canvas = this.bannerCanvas;
    const panel = this.bannerPanel;
    const context = canvas?.getContext('2d');
    if (canvas == null || panel == null || context == null) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.shadowColor = 'rgba(70, 52, 40, 0.22)';
    context.shadowBlur = 16;
    context.fillStyle = 'rgba(255, 249, 240, 0.98)';
    context.beginPath();
    context.roundRect(18, 18, 988, 220, 62);
    context.fill();
    context.shadowColor = 'transparent';
    context.strokeStyle = '#D7C7B8';
    context.lineWidth = 6;
    context.stroke();

    const username = this.broadcasterLogin ?? 'streamer';
    const prefix = 'Hang Out in';
    const suffix = "'s World!";
    context.textAlign = 'center';
    context.fillStyle = '#2C3434';
    context.font = '900 66px system-ui, sans-serif';
    context.fillText(prefix, 512, 104);

    let secondLineSize = 66;
    context.font = `900 ${secondLineSize}px system-ui, sans-serif`;
    const desiredWidth = context.measureText(`${username}${suffix}`).width;
    if (desiredWidth > 900) secondLineSize = Math.max(44, secondLineSize * (900 / desiredWidth));
    context.font = `900 ${secondLineSize}px system-ui, sans-serif`;
    const usernameWidth = context.measureText(username).width;
    const suffixWidth = context.measureText(suffix).width;
    let x = (canvas.width - usernameWidth - suffixWidth) / 2;
    context.textAlign = 'left';
    context.fillStyle = '#C94F78';
    context.fillText(username, x, 183);
    x += usernameWidth;
    context.fillStyle = '#2C3434';
    context.fillText(suffix, x, 183);
    context.textAlign = 'center';
    if (panel.material.map != null) panel.material.map.needsUpdate = true;
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
