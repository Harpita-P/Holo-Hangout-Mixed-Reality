import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { isClientMessage, type ServerMessage } from '../shared/protocol.js';
import { HostedTwitchAccount, verifyTwitchWebhook } from './hosted-twitch.js';
import { HangoutMomentsService } from './hangout-moments.js';
import { ParticipantManager } from './participant-manager.js';
import {
  createCsrfToken,
  createPlatformToken,
  parseCookies,
  randomIdentifier,
  safeEqual,
  verifyPlatformToken,
} from './platform-security.js';
import { PlatformStore, type StreamerAccount } from './platform-store.js';
import type { TwitchStatus, TwitchToken } from './twitch-eventsub.js';

const config = loadConfig();
const store = new PlatformStore(join(config.dataDir, 'platform.json'), config.tokenKey);
const runtimes = new Map<string, StreamerRuntime>();
const worldRuntimes = new Map<string, StreamerRuntime>();
const seenWebhookMessages = new Set<string>();

class StreamerRuntime {
  readonly clients = new Set<WebSocket>();
  readonly participants: ParticipantManager;
  readonly twitch: HostedTwitchAccount;
  readonly moments: HangoutMomentsService;
  twitchStatus: TwitchStatus;

  constructor(private account: StreamerAccount) {
    this.twitchStatus = {
      connected: false,
      broadcasterLogin: account.login,
      clipsAuthorized: false,
      error: null,
    };
    this.participants = new ParticipantManager({
      emit: (message) => this.broadcast(message),
      onRealViewerJoined: (participant) => {
        const abilities = participant.supportedCommands
          .filter((command) => command !== '!join' && command !== '!leave')
          .join(' ');
        void this.twitch.sendChatMessage(
          `@${participant.displayName} joined HoloHangout as ${participant.monsterName}! Abilities: ${abilities}`,
        ).catch((error: unknown) => console.error(safeError(error)));
      },
    });
    this.twitch = new HostedTwitchAccount(
      twitchConfig(),
      (token) => this.saveToken(token),
      (status) => {
        this.twitchStatus = status;
        this.broadcast(this.statusMessage());
      },
    );
    this.moments = new HangoutMomentsService(
      this.twitch,
      join(config.dataDir, 'moments', `${account.twitchUserId}.json`),
      () => undefined,
      (clip) => this.broadcast({ type: 'hangout.moment', clipId: clip.id }),
    );
  }

  async start(): Promise<void> {
    await this.moments.load();
    this.participants.setAcceptingJoins(this.account.settings.acceptingJoins);
    this.participants.setDemoMode(this.account.settings.demoEnabled);
    await this.twitch.restore(this.account.token).catch((error: unknown) => {
      this.twitchStatus = {
        connected: false,
        broadcasterLogin: this.account.login,
        clipsAuthorized: false,
        error: safeError(error),
      };
    });
  }

  stop(): void {
    this.twitch.disconnect();
    this.participants.clear();
    for (const client of this.clients) client.close(1001, 'HoloHangout session restarting');
    this.clients.clear();
  }

  handleChat(userId: string, displayName: string, text: string): void {
    this.participants.handleChat({ userId, displayName, text });
  }

  connect(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on('message', (raw) => {
      try {
        const message: unknown = JSON.parse(raw.toString());
        if (!isClientMessage(message)) return;
        if (message.type === 'client.ready') {
          socket.send(JSON.stringify(this.participants.snapshotMessage()));
          socket.send(JSON.stringify(this.participants.leaderboardMessage()));
          socket.send(JSON.stringify(this.statusMessage()));
        } else if (message.type === 'challenge.completed') {
          void this.moments.completeChallenge(message.challengeId).catch((error: unknown) => {
            console.error(safeError(error));
          });
        }
      } catch {
        // A fresh snapshot on reconnect restores authoritative world state.
      }
    });
    socket.on('close', () => this.clients.delete(socket));
  }

  status(): Record<string, unknown> {
    const realParticipants = this.participants.snapshot().filter(({ isBot }) => !isBot);
    return {
      twitch: this.twitchStatus,
      world: {
        id: this.account.worldId,
        connected: this.clients.size > 0,
        connectionCount: this.clients.size,
      },
      acceptingJoins: this.participants.snapshotMessage().acceptingJoins,
      participants: realParticipants.map(({ userId, displayName, behavior, monsterName, supportedCommands }) => ({
        userId,
        displayName,
        behavior,
        monsterName,
        supportedCommands,
      })),
      community: {
        realViewerCount: realParticipants.length,
        capacity: this.participants.demoStatus().capacity,
      },
      demo: this.participants.demoStatus(),
      moments: this.moments.status(),
    };
  }

  accountSnapshot(): StreamerAccount {
    return { ...this.account, token: { ...this.account.token }, settings: { ...this.account.settings } };
  }

  async setAcceptingJoins(accepting: boolean): Promise<void> {
    this.participants.setAcceptingJoins(accepting);
    this.account.settings.acceptingJoins = accepting;
    await this.persistAccount();
  }

  async setDemoMode(enabled: boolean): Promise<void> {
    this.participants.setDemoMode(enabled);
    this.account.settings.demoEnabled = enabled;
    await this.persistAccount();
  }

  async clearParticipants(): Promise<void> {
    this.participants.clear();
    this.account.settings.demoEnabled = false;
    await this.persistAccount();
  }

  private statusMessage(): ServerMessage {
    return {
      type: 'server.status',
      twitchConnected: this.twitchStatus.connected,
      broadcasterLogin: this.twitchStatus.broadcasterLogin,
    };
  }

  private broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  private async saveToken(token: TwitchToken): Promise<void> {
    this.account.token = { ...token };
    this.account.login = token.login;
    await this.persistAccount();
  }

  private async persistAccount(): Promise<void> {
    this.account.updatedAt = new Date().toISOString();
    await store.save(this.account);
  }
}

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
const server = createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(safeError(error));
    sendJson(response, status, { error: error instanceof Error ? error.message : 'HoloHangout server error.' });
  });
});

server.on('upgrade', (request, socket, head) => {
  const url = requestUrl(request);
  const origin = request.headers.origin;
  if (url.pathname !== '/ws' || (origin != null && origin !== config.frontendOrigin)) {
    socket.destroy();
    return;
  }
  const worldId = url.searchParams.get('world') ?? '';
  const credential = verifyPlatformToken(
    url.searchParams.get('credential') ?? undefined,
    config.sessionSecret,
    'world',
  );
  const runtime = worldRuntimes.get(worldId);
  if (
    runtime == null ||
    credential == null ||
    credential.worldId !== worldId ||
    credential.subject !== runtime.accountSnapshot().twitchUserId
  ) {
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (webSocket) => runtime.connect(webSocket));
});

async function main(): Promise<void> {
  await store.load();
  for (const account of store.list()) await registerRuntime(account);
  server.listen(config.port, config.host, () => {
    console.log(`HoloHangout platform server listening on ${config.host}:${config.port}`);
  });
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  applyCors(request, response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  const url = requestUrl(request);
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true, service: 'holohangout-platform', streamers: runtimes.size });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/auth/twitch') {
    const nonce = randomIdentifier();
    const state = createPlatformToken(
      { kind: 'oauth', subject: 'twitch-connect', nonce },
      config.sessionSecret,
      10 * 60_000,
    );
    response.setHeader('Set-Cookie', cookie('hh_oauth', nonce, 10 * 60, true));
    const account = temporaryTwitchAccount();
    redirect(response, account.createAuthorizationUrl(state));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/auth/twitch/callback') {
    const state = verifyPlatformToken(url.searchParams.get('state') ?? undefined, config.sessionSecret, 'oauth');
    const nonce = parseCookies(request.headers.cookie).get('hh_oauth');
    const code = url.searchParams.get('code');
    if (state == null || code == null || !safeEqual(nonce, state.nonce ?? '')) {
      throw new HttpError(400, 'Invalid or expired Twitch authorization state.');
    }
    let authorizedToken: TwitchToken | null = null;
    const twitch = new HostedTwitchAccount(
      twitchConfig(),
      (token) => { authorizedToken = { ...token }; },
      () => undefined,
    );
    const token = await twitch.authorize(code);
    twitch.disconnect();
    const existing = store.get(token.userId);
    const now = new Date().toISOString();
    const account: StreamerAccount = {
      twitchUserId: token.userId,
      login: token.login,
      worldId: existing?.worldId ?? randomIdentifier(12),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      token: authorizedToken ?? token,
      settings: existing?.settings ?? { acceptingJoins: true, demoEnabled: false },
    };
    await store.save(account);
    await registerRuntime(account);
    const dashboardToken = createPlatformToken(
      { kind: 'dashboard', subject: account.twitchUserId },
      config.sessionSecret,
      7 * 24 * 60 * 60_000,
    );
    response.setHeader('Set-Cookie', [
      cookie('hh_session', dashboardToken, 7 * 24 * 60 * 60, true),
      cookie('hh_oauth', '', 0, true),
    ]);
    redirect(response, `${config.frontendOrigin}/dashboard#session=${encodeURIComponent(dashboardToken)}`);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/twitch/eventsub') {
    const rawBody = await readBody(request);
    if (!verifyTwitchWebhook(request.headers, rawBody, config.eventSubSecret)) {
      throw new HttpError(403, 'Invalid Twitch EventSub signature.');
    }
    const messageId = singleHeader(request.headers['twitch-eventsub-message-id']) ?? '';
    const messageType = singleHeader(request.headers['twitch-eventsub-message-type']);
    const body = JSON.parse(rawBody) as {
      challenge?: string;
      event?: {
        broadcaster_user_id?: string;
        chatter_user_id?: string;
        chatter_user_name?: string;
        message?: { text?: string };
      };
    };
    if (messageType === 'webhook_callback_verification' && body.challenge) {
      sendText(response, 200, body.challenge);
      return;
    }
    if (seenWebhookMessages.has(messageId)) {
      sendJson(response, 204, null);
      return;
    }
    rememberWebhookMessage(messageId);
    if (messageType === 'notification') {
      const event = body.event;
      const runtime = event?.broadcaster_user_id == null
        ? null
        : runtimes.get(event.broadcaster_user_id);
      if (runtime != null && event?.chatter_user_id && event.chatter_user_name && event.message?.text) {
        runtime.handleChat(event.chatter_user_id, event.chatter_user_name, event.message.text);
      }
    }
    sendJson(response, 204, null);
    return;
  }

  const authenticated = authenticatedRuntime(request);
  if (request.method === 'GET' && (url.pathname === '/api/session' || url.pathname === '/api/status')) {
    const credential = createPlatformToken(
      {
        kind: 'world',
        subject: authenticated.accountSnapshot().twitchUserId,
        worldId: authenticated.accountSnapshot().worldId,
      },
      config.sessionSecret,
      8 * 60 * 60_000,
    );
    const worldPath = `/world/${encodeURIComponent(authenticated.accountSnapshot().worldId)}`;
    sendJson(response, 200, {
      authenticated: true,
      csrfToken: createCsrfToken(authenticated.accountSnapshot().twitchUserId, config.sessionSecret),
      streamer: {
        login: authenticated.accountSnapshot().login,
        worldId: authenticated.accountSnapshot().worldId,
      },
      worldUrl: `${config.frontendOrigin}${worldPath}#credential=${encodeURIComponent(credential)}`,
      ...authenticated.status(),
    });
    return;
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/admin/')) {
    requireControlRequest(request, authenticated);
    const body = await readJson(request);
    if (url.pathname === '/api/admin/joins') {
      await authenticated.setAcceptingJoins(body.accepting === true);
    } else if (url.pathname === '/api/admin/clear') {
      await authenticated.clearParticipants();
    } else if (url.pathname === '/api/admin/participants/remove') {
      if (typeof body.userId !== 'string' || !authenticated.participants.remove(body.userId)) {
        throw new HttpError(404, 'Viewer is not currently active.');
      }
    } else if (url.pathname === '/api/admin/demo') {
      await authenticated.setDemoMode(body.enabled === true);
    } else if (url.pathname === '/api/admin/moments/auto') {
      await authenticated.moments.setAutoClipEnabled(body.enabled === true);
    } else if (url.pathname === '/api/admin/moments/clip') {
      await authenticated.moments.createManualMoment();
    } else {
      throw new HttpError(404, 'Not found.');
    }
    sendJson(response, 200, { ok: true, ...authenticated.status() });
    return;
  }
  throw new HttpError(404, 'Not found.');
}

async function registerRuntime(account: StreamerAccount): Promise<StreamerRuntime> {
  const previous = runtimes.get(account.twitchUserId);
  previous?.stop();
  if (previous != null) worldRuntimes.delete(previous.accountSnapshot().worldId);
  const runtime = new StreamerRuntime(account);
  runtimes.set(account.twitchUserId, runtime);
  worldRuntimes.set(account.worldId, runtime);
  await runtime.start();
  return runtime;
}

function temporaryTwitchAccount(): HostedTwitchAccount {
  return new HostedTwitchAccount(twitchConfig(), () => undefined, () => undefined);
}

function twitchConfig() {
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    eventSubCallbackUrl: `${config.publicUrl}/twitch/eventsub`,
    eventSubSecret: config.eventSubSecret,
  };
}

function authenticatedRuntime(request: IncomingMessage): StreamerRuntime {
  const authorization = singleHeader(request.headers.authorization);
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  const session = verifyPlatformToken(
    bearer ?? parseCookies(request.headers.cookie).get('hh_session'),
    config.sessionSecret,
    'dashboard',
  );
  const runtime = session == null ? null : runtimes.get(session.subject);
  if (runtime == null) throw new HttpError(401, 'Connect with Twitch to access this dashboard.');
  return runtime;
}

function requireControlRequest(request: IncomingMessage, runtime: StreamerRuntime): void {
  if (request.headers.origin !== config.frontendOrigin) {
    throw new HttpError(403, 'Invalid dashboard request origin.');
  }
  const expected = createCsrfToken(runtime.accountSnapshot().twitchUserId, config.sessionSecret);
  if (!safeEqual(singleHeader(request.headers['x-holohangout-csrf']), expected)) {
    throw new HttpError(403, 'Invalid dashboard request token.');
  }
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  if (request.headers.origin === config.frontendOrigin) {
    response.setHeader('Access-Control-Allow-Origin', config.frontendOrigin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-HoloHangout-CSRF');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
}

function cookie(name: string, value: string, maxAgeSeconds: number, httpOnly: boolean): string {
  const secure = config.publicUrl.startsWith('https:');
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    httpOnly ? 'HttpOnly' : '',
    secure ? 'Secure' : '',
    secure ? 'SameSite=None' : 'SameSite=Lax',
  ].filter(Boolean);
  return attributes.join('; ');
}

function rememberWebhookMessage(messageId: string): void {
  if (!messageId) return;
  seenWebhookMessages.add(messageId);
  if (seenWebhookMessages.size > 2000) {
    const oldest = seenWebhookMessages.values().next().value as string | undefined;
    if (oldest != null) seenWebhookMessages.delete(oldest);
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request);
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
      throw new Error('Expected an object.');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON request body.');
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new HttpError(413, 'Request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', config.publicUrl);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { Location: location });
  response.end();
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(status === 204 ? undefined : JSON.stringify(body));
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the hosted HoloHangout server.`);
  return value;
}

function loadConfig() {
  const port = Number.parseInt(process.env.PORT ?? process.env.HOLOHANGOUT_PORT ?? '8788', 10);
  const publicUrl = (process.env.HOLOHANGOUT_PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/$/u, '');
  const frontendOrigin = (process.env.HOLOHANGOUT_FRONTEND_ORIGIN?.trim() || 'https://localhost:8081').replace(/\/$/u, '');
  return {
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: Number.isFinite(port) ? port : 8788,
    publicUrl,
    frontendOrigin,
    redirectUri: process.env.TWITCH_REDIRECT_URI?.trim() || `${publicUrl}/auth/twitch/callback`,
    clientId: requiredEnv('TWITCH_CLIENT_ID'),
    clientSecret: requiredEnv('TWITCH_CLIENT_SECRET'),
    sessionSecret: requiredEnv('HOLOHANGOUT_SESSION_SECRET'),
    tokenKey: requiredEnv('HOLOHANGOUT_TOKEN_KEY'),
    eventSubSecret: requiredEnv('TWITCH_EVENTSUB_SECRET'),
    dataDir: resolve(process.env.HOLOHANGOUT_DATA_DIR?.trim() || '.holohangout'),
  };
}

function shutdown(): void {
  for (const runtime of runtimes.values()) runtime.stop();
  webSockets.close();
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
void main().catch((error: unknown) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
