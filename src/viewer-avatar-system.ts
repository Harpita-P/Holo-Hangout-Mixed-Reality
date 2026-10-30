import {
  CanvasTexture,
  Color,
  createSystem,
  type Entity,
  Grabbed,
  GrabSystem,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Object3D,
} from '@iwsdk/core';
import {
  AvatarBehaviors,
  type AvatarBehavior,
  type ParticipantSnapshot,
  type ServerMessage,
} from '../shared/protocol.js';
import { ChatIRLSocket, type SocketStatus } from './chatirl-socket.js';
import { ViewerAvatar } from './viewer-avatar-component.js';

interface AvatarRuntime {
  entity: Entity;
  initialX: number;
  initialY: number;
  initialZ: number;
  actionStartedAt: number;
  leavingAt: number;
  leftArm: Object3D | null;
  rightArm: Object3D | null;
  label: Sprite | null;
}

const TABLE_MIN_X = -0.255;
const TABLE_MAX_X = 0.255;
const TABLE_MIN_Z = -0.165;
const TABLE_MAX_Z = 0.165;

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
      const userId = entity.getValue(ViewerAvatar, 'userId');
      if (userId) this.socket?.send({ type: 'avatar.held', userId, held: true });
    });
    const offReleased = this.queries.held.subscribe('disqualify', (entity) => {
      this.settleOnTable(entity);
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
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message != null) this.applyMessage(message, time);
    }
    for (const [entity, runtime] of this.runtimes) {
      if (!entity.object3D?.visible || this.queries.held.entities.has(entity)) continue;
      this.animate(entity, runtime, delta, time);
    }
  }

  private prepareSlot(entity: Entity): void {
    const object = entity.object3D;
    if (object == null) return;
    object.visible = false;
    object.traverse((child) => {
      if (!(child instanceof Mesh) || !(child.material instanceof MeshStandardMaterial)) {
        return;
      }
      child.material = child.material.clone();
    });
    this.runtimes.set(entity, {
      entity,
      initialX: object.position.x,
      initialY: object.position.y,
      initialZ: object.position.z,
      actionStartedAt: 0,
      leavingAt: 0,
      leftArm: object.getObjectByName('Left Arm') ?? null,
      rightArm: object.getObjectByName('Right Arm') ?? null,
      label: null,
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
      case 'avatar.action':
        this.applyAction(
          message.userId,
          message.behavior,
          message.actionSequence,
          message.targetX,
          message.targetZ,
          time,
        );
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

    this.userEntities.set(participant.userId, entity);
    entity.setValue(ViewerAvatar, 'userId', participant.userId);
    entity.setValue(ViewerAvatar, 'displayName', participant.displayName);
    entity.setValue(ViewerAvatar, 'colorHex', participant.colorHex);
    entity.setValue(ViewerAvatar, 'behavior', participant.behavior);
    entity.setValue(ViewerAvatar, 'actionSequence', participant.actionSequence);
    entity.setValue(ViewerAvatar, 'targetX', participant.targetX);
    entity.setValue(ViewerAvatar, 'targetZ', participant.targetZ);

    const object = entity.object3D;
    if (!object.visible) {
      object.position.set(runtime.initialX, runtime.initialY, runtime.initialZ);
      object.rotation.set(0, 0, 0);
      object.scale.setScalar(1);
    }
    object.visible = true;
    runtime.actionStartedAt = time;
    runtime.leavingAt = 0;
    this.applyColor(object, participant.colorHex);
    this.setLabel(runtime, participant.displayName);
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
    if (entity == null) return;
    entity.setValue(ViewerAvatar, 'behavior', behavior);
    entity.setValue(ViewerAvatar, 'actionSequence', actionSequence);
    entity.setValue(ViewerAvatar, 'targetX', targetX);
    entity.setValue(ViewerAvatar, 'targetZ', targetZ);
    const runtime = this.runtimes.get(entity);
    if (runtime != null) runtime.actionStartedAt = time;
  }

  private beginLeave(userId: string, deadlineMs: number, time: number): void {
    const entity = this.userEntities.get(userId);
    const runtime = entity == null ? null : this.runtimes.get(entity);
    if (entity == null || runtime == null) return;
    if (this.queries.held.entities.has(entity)) this.grabSystem?.forceRelease(entity);
    entity.setValue(ViewerAvatar, 'behavior', AvatarBehaviors.Leaving);
    runtime.actionStartedAt = time;
    runtime.leavingAt = time + Math.max(0, Math.min(deadlineMs, 1000)) / 1000;
  }

  private deactivate(userId: string): void {
    const entity = this.userEntities.get(userId);
    const runtime = entity == null ? null : this.runtimes.get(entity);
    if (entity == null || runtime == null || entity.object3D == null) return;
    if (this.queries.held.entities.has(entity)) this.grabSystem?.forceRelease(entity);
    entity.object3D.visible = false;
    entity.object3D.scale.setScalar(1);
    entity.setValue(ViewerAvatar, 'userId', '');
    entity.setValue(ViewerAvatar, 'displayName', '');
    entity.setValue(ViewerAvatar, 'behavior', AvatarBehaviors.Idle);
    this.removeLabel(runtime);
    this.userEntities.delete(userId);
  }

  private animate(
    entity: Entity,
    runtime: AvatarRuntime,
    delta: number,
    time: number,
  ): void {
    const object = entity.object3D;
    if (object == null) return;
    const behavior = entity.getValue(ViewerAvatar, 'behavior');
    const elapsed = Math.max(0, time - runtime.actionStartedAt);
    object.rotation.z = 0;
    if (runtime.leftArm != null) runtime.leftArm.rotation.z = 0;
    if (runtime.rightArm != null) runtime.rightArm.rotation.z = 0;

    switch (behavior) {
      case AvatarBehaviors.Run: {
        const targetX = entity.getValue(ViewerAvatar, 'targetX') ?? object.position.x;
        const targetZ = entity.getValue(ViewerAvatar, 'targetZ') ?? object.position.z;
        const dx = targetX - object.position.x;
        const dz = targetZ - object.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 0.008) {
          entity.setValue(ViewerAvatar, 'behavior', AvatarBehaviors.Idle);
          break;
        }
        const step = Math.min(distance, 0.22 * Math.min(delta, 1 / 15));
        object.position.x += (dx / distance) * step;
        object.position.z += (dz / distance) * step;
        object.rotation.y = Math.atan2(dx, dz);
        object.position.y = runtime.initialY + Math.abs(Math.sin(elapsed * 13)) * 0.008;
        break;
      }
      case AvatarBehaviors.Wave:
        if (runtime.rightArm != null) {
          runtime.rightArm.rotation.z = -1.8 + Math.sin(elapsed * 12) * 0.35;
        }
        break;
      case AvatarBehaviors.Dance:
        object.rotation.z = Math.sin(elapsed * 7) * 0.28;
        object.rotation.y = Math.sin(elapsed * 3.5) * 0.45;
        if (runtime.leftArm != null) runtime.leftArm.rotation.z = 1.2;
        if (runtime.rightArm != null) runtime.rightArm.rotation.z = -1.2;
        break;
      case AvatarBehaviors.Jump: {
        const progress = Math.min(1, elapsed / 1.05);
        object.position.y = runtime.initialY + Math.sin(progress * Math.PI) * 0.09;
        if (progress >= 1) entity.setValue(ViewerAvatar, 'behavior', AvatarBehaviors.Idle);
        break;
      }
      case AvatarBehaviors.Leaving: {
        const remaining = Math.max(0, runtime.leavingAt - time);
        object.rotation.y += 0.08;
        object.scale.setScalar(Math.max(0.001, Math.min(1, remaining * 4)));
        if (time >= runtime.leavingAt) {
          const userId = entity.getValue(ViewerAvatar, 'userId');
          if (userId) this.deactivate(userId);
        }
        break;
      }
      default:
        object.position.y = runtime.initialY + Math.sin(time * 2.1 + entity.index) * 0.0025;
        if (runtime.leftArm != null) runtime.leftArm.rotation.z = Math.sin(time * 1.7) * 0.08;
        if (runtime.rightArm != null) runtime.rightArm.rotation.z = -Math.sin(time * 1.7) * 0.08;
    }
  }

  private settleOnTable(entity: Entity): void {
    const runtime = this.runtimes.get(entity);
    const object = entity.object3D;
    if (runtime == null || object == null || !object.visible) return;
    object.position.x = Math.min(TABLE_MAX_X, Math.max(TABLE_MIN_X, object.position.x));
    object.position.z = Math.min(TABLE_MAX_Z, Math.max(TABLE_MIN_Z, object.position.z));
    object.position.y = runtime.initialY;
    object.rotation.x = 0;
    object.rotation.z = 0;
  }

  private applyColor(root: Object3D, colorHex: string): void {
    const color = new Color(colorHex);
    root.traverse((child) => {
      if (
        child instanceof Mesh &&
        child.material instanceof MeshStandardMaterial &&
        child.material.name === 'AvatarTint'
      ) {
        child.material.color.copy(color);
      }
    });
  }

  private setLabel(runtime: AvatarRuntime, displayName: string): void {
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
    label.position.set(0, 0.225, 0);
    label.scale.set(0.19, 0.036, 1);
    label.renderOrder = 20;
    runtime.entity.object3D.add(label);
    runtime.label = label;
  }

  private removeLabel(runtime: AvatarRuntime): void {
    const label = runtime.label;
    if (label == null) return;
    label.removeFromParent();
    label.material.map?.dispose();
    label.material.dispose();
    runtime.label = null;
  }

  private setSocketStatus(status: SocketStatus): void {
    this.backendConnected = status === 'connected';
    if (!this.backendConnected) this.twitchConnected = false;
    this.renderStatus();
  }

  private renderStatus(): void {
    if (this.statusElement == null) return;
    this.statusElement.dataset.state = this.twitchConnected
      ? 'ready'
      : this.backendConnected
        ? 'waiting'
        : 'offline';
    this.statusElement.textContent = this.twitchConnected
      ? `Twitch connected: ${this.broadcasterLogin ?? 'streamer'}`
      : this.backendConnected
        ? 'ChatIRL backend connected — authorize Twitch'
        : 'ChatIRL backend offline';
  }
}
