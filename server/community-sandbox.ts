import { randomUUID } from 'node:crypto';
import type { ParticipantSnapshot, ServerMessage } from '../shared/protocol.js';
import {
  type CommunitySandboxSnapshot,
  type SandboxCreationSnapshot,
  type SandboxRequestSnapshot,
  type VoxelBlueprint,
} from '../shared/community-sandbox.js';
import { generateMockBlueprint } from './community-sandbox-mock.js';
import { OpenAIVoxelGenerator } from './openai-voxel-generator.js';

interface ManagedRequest extends SandboxRequestSnapshot {
  isDemo: boolean;
  timer: NodeJS.Timeout | null;
}

export interface CommunitySandboxOptions {
  emit: (message: ServerMessage) => void;
  participant: (userId: string) => ParticipantSnapshot | null;
  apiKey: string;
  model?: string;
  generator?: 'openai' | 'mock';
  sessionLimit?: number;
  requestLifetimeMs?: number;
  viewerCooldownMs?: number;
  generateBlueprint?: (prompt: string) => Promise<VoxelBlueprint>;
}

export class CommunitySandbox {
  private readonly requests = new Map<string, ManagedRequest>();
  private readonly creations: SandboxCreationSnapshot[] = [];
  private readonly cooldowns = new Map<string, number>();
  private readonly heldSince = new Map<string, number>();
  private readonly heldApprovalTimers = new Map<string, NodeJS.Timeout>();
  private readonly generationQueue: ManagedRequest[] = [];
  private readonly model: string;
  private readonly generatorMode: 'openai' | 'mock';
  private readonly sessionLimit: number;
  private readonly requestLifetimeMs: number;
  private readonly viewerCooldownMs: number;
  private readonly openai: OpenAIVoxelGenerator | null;
  private readonly generateBlueprint: ((prompt: string) => Promise<VoxelBlueprint>) | null;
  private active = false;
  private generationInProgress = false;
  private completedThisSession = 0;
  private lastError: string | null = null;

  constructor(private readonly options: CommunitySandboxOptions) {
    this.model = options.model?.trim() || 'gpt-6-luna';
    this.generatorMode = options.generator ?? 'openai';
    this.sessionLimit = options.sessionLimit ?? 20;
    this.requestLifetimeMs = options.requestLifetimeMs ?? 45_000;
    this.viewerCooldownMs = options.viewerCooldownMs ?? 30_000;
    this.openai = options.apiKey ? new OpenAIVoxelGenerator(options.apiKey, this.model) : null;
    this.generateBlueprint = options.generateBlueprint ?? null;
  }

  status(): CommunitySandboxSnapshot {
    const values = [...this.requests.values()];
    return {
      active: this.active,
      generator: this.generatorMode,
      apiKeyConfigured: this.openai != null,
      model: this.model,
      pending: values.filter(({ status }) => status === 'pending').map(publicRequest),
      generating: values.filter(({ status }) => status === 'generating').map(publicRequest),
      creations: this.creations,
      remainingAllowance: Math.max(0, this.sessionLimit - this.completedThisSession),
      sessionLimit: this.sessionLimit,
      lastError: this.lastError,
    };
  }

  dashboardStatus() {
    const status = this.status();
    return {
      active: status.active,
      generator: status.generator,
      apiKeyConfigured: status.apiKeyConfigured,
      model: status.model,
      pendingCount: status.pending.length,
      generatingCount: status.generating.length,
      creationCount: status.creations.length,
      remainingAllowance: status.remainingAllowance,
      sessionLimit: status.sessionLimit,
      lastError: status.lastError,
    };
  }

  snapshotMessage(): Extract<ServerMessage, { type: 'sandbox.snapshot' }> {
    return { type: 'sandbox.snapshot', sandbox: this.status() };
  }

  start(): CommunitySandboxSnapshot {
    this.active = true;
    this.lastError = null;
    this.options.emit({ type: 'sandbox.notice', text: 'Community Sandbox is Open!' });
    this.options.emit(this.snapshotMessage());
    return this.status();
  }

  stop(): CommunitySandboxSnapshot {
    this.active = false;
    for (const request of [...this.requests.values()]) {
      if (request.status === 'pending') this.resolveRequest(request, 'Sandbox closed before approval.');
    }
    this.options.emit(this.snapshotMessage());
    return this.status();
  }

  submit(userId: string, displayName: string, rawPrompt: string, allowDemo = false): boolean {
    if (!this.active || this.creations.length >= 10 || this.completedThisSession >= this.sessionLimit) return false;
    const participant = this.options.participant(userId);
    if (participant == null || (!allowDemo && participant.isBot)) return false;
    if ([...this.requests.values()].some((request) => request.userId === userId)) return false;
    const now = Date.now();
    if ((this.cooldowns.get(userId) ?? 0) > now) return false;
    if ([...this.requests.values()].filter(({ status }) => status === 'pending').length >= 5) return false;
    const prompt = sanitizePrompt(rawPrompt);
    if (prompt == null) return false;
    const request: ManagedRequest = {
      id: randomUUID(),
      userId,
      displayName: participant.displayName || displayName,
      prompt,
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.requestLifetimeMs,
      isDemo: allowDemo,
      timer: null,
    };
    request.timer = setTimeout(() => this.expire(request.id), this.requestLifetimeMs);
    request.timer.unref();
    this.requests.set(request.id, request);
    this.lastError = null;
    this.options.emit({ type: 'sandbox.request', request: publicRequest(request) });
    return true;
  }

  setHeld(userId: string, held: boolean, now = Date.now()): void {
    const existingTimer = this.heldApprovalTimers.get(userId);
    if (existingTimer != null) clearTimeout(existingTimer);
    this.heldApprovalTimers.delete(userId);
    if (!held) {
      this.heldSince.delete(userId);
      return;
    }
    this.heldSince.set(userId, now);
    const timer = setTimeout(() => {
      this.heldApprovalTimers.delete(userId);
      const request = [...this.requests.values()].find(
        (candidate) => candidate.userId === userId && candidate.status === 'pending',
      );
      if (request != null) this.approve(request.id, userId);
    }, 400);
    timer.unref();
    this.heldApprovalTimers.set(userId, timer);
  }

  approve(requestId: string, userId: string, now = Date.now()): boolean {
    const request = this.requests.get(requestId);
    const heldSince = this.heldSince.get(userId);
    if (
      request == null || request.status !== 'pending' || request.userId !== userId ||
      request.expiresAt <= now || heldSince == null || now - heldSince < 350 ||
      this.generationQueue.length + (this.generationInProgress ? 1 : 0) >= 3
    ) return false;
    if (this.generatorMode === 'openai' && this.openai == null && this.generateBlueprint == null) {
      this.lastError = 'Add OPENAI_API_KEY to .env, then restart HoloHangout.';
      this.options.emit({ type: 'sandbox.notice', text: 'Sandbox needs an OpenAI API key.' });
      this.options.emit(this.snapshotMessage());
      return false;
    }
    if (request.timer != null) clearTimeout(request.timer);
    request.timer = null;
    request.status = 'generating';
    this.generationQueue.push(request);
    this.options.emit({ type: 'sandbox.request', request: publicRequest(request) });
    this.options.emit(this.snapshotMessage());
    void this.processQueue();
    return true;
  }

  viewerLeft(userId: string): void {
    const approvalTimer = this.heldApprovalTimers.get(userId);
    if (approvalTimer != null) clearTimeout(approvalTimer);
    this.heldApprovalTimers.delete(userId);
    this.heldSince.delete(userId);
    const request = [...this.requests.values()].find(
      (candidate) => candidate.userId === userId && candidate.status === 'pending',
    );
    if (request != null) this.resolveRequest(request, 'Viewer left before approval.');
  }

  clearCreations(): CommunitySandboxSnapshot {
    this.creations.length = 0;
    this.options.emit({ type: 'sandbox.cleared' });
    this.options.emit(this.snapshotMessage());
    return this.status();
  }

  shutdown(): void {
    for (const timer of this.heldApprovalTimers.values()) clearTimeout(timer);
    this.heldApprovalTimers.clear();
    for (const request of this.requests.values()) if (request.timer != null) clearTimeout(request.timer);
    this.requests.clear();
    this.generationQueue.length = 0;
  }

  private expire(requestId: string): void {
    const request = this.requests.get(requestId);
    if (request?.status === 'pending') this.resolveRequest(request, 'Build request expired.');
  }

  private resolveRequest(request: ManagedRequest, notice?: string): void {
    if (request.timer != null) clearTimeout(request.timer);
    this.requests.delete(request.id);
    this.cooldowns.set(request.userId, Date.now() + this.viewerCooldownMs);
    this.options.emit({ type: 'sandbox.request.removed', requestId: request.id, userId: request.userId });
    if (notice) this.lastError = notice;
  }

  private async processQueue(): Promise<void> {
    if (this.generationInProgress) return;
    const request = this.generationQueue.shift();
    if (request == null) return;
    this.generationInProgress = true;
    try {
      const blueprint = await this.generate(request);
      if (this.creations.length >= 10 || this.completedThisSession >= this.sessionLimit) {
        throw new Error('Sandbox creation limit reached.');
      }
      const creation: SandboxCreationSnapshot = {
        id: randomUUID(),
        requestId: request.id,
        userId: request.userId,
        displayName: request.displayName,
        slot: this.nextCreationSlot(),
        createdAt: Date.now(),
        blueprint,
      };
      this.creations.push(creation);
      this.completedThisSession += 1;
      this.lastError = null;
      this.options.emit({ type: 'sandbox.creation.ready', creation });
      this.options.emit({ type: 'sandbox.notice', text: `${request.displayName} created: ${blueprint.name}!` });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.emit({ type: 'sandbox.notice', text: `Could not create ${request.prompt}.` });
    } finally {
      this.resolveRequest(request);
      this.generationInProgress = false;
      this.options.emit(this.snapshotMessage());
      void this.processQueue();
    }
  }

  private generate(request: ManagedRequest): Promise<VoxelBlueprint> {
    if (request.isDemo || this.generatorMode === 'mock') {
      return Promise.resolve(generateMockBlueprint(request.prompt));
    }
    if (this.generateBlueprint != null) return this.generateBlueprint(request.prompt);
    if (this.openai == null) return Promise.reject(new Error('OPENAI_API_KEY is not configured.'));
    return this.openai.generate(request.prompt);
  }

  private nextCreationSlot(): number {
    const used = new Set(this.creations.map(({ slot }) => slot));
    for (let slot = 0; slot < 10; slot += 1) if (!used.has(slot)) return slot;
    return 0;
  }
}

function publicRequest(request: ManagedRequest): SandboxRequestSnapshot {
  const { isDemo: _isDemo, timer: _timer, ...snapshot } = request;
  return snapshot;
}

function sanitizePrompt(value: string): string | null {
  const prompt = [...value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim()]
    .slice(0, 101).join('');
  if (!prompt || [...prompt].length > 100 || prompt.startsWith('!') || /https?:\/\//iu.test(prompt)) return null;
  if (!/[\p{L}\p{N}]/u.test(prompt)) return null;
  const blocked = /\b(?:porn|nude|naked|sex|genitals?|swastika|lynch|gore|suicide|weapon|gun|rifle|bomb)\b/iu;
  return blocked.test(prompt) ? null : prompt;
}

export function parseBuildCommand(text: string): string | null {
  const match = /^!build(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  return match == null ? null : (match[1] ?? '');
}
