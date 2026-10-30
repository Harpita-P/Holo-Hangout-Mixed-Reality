import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { isClientMessage, type ServerMessage } from '../shared/protocol.js';
import { ParticipantManager, type ChatMessage } from './participant-manager.js';
import {
  TwitchEventSub,
  type TwitchStatus,
  type TwitchToken,
} from './twitch-eventsub.js';

const host = '127.0.0.1';
const port = numberFromEnv('CHATIRL_PORT', 8787);
const redirectUri =
  process.env.TWITCH_REDIRECT_URI?.trim() ||
  `http://localhost:${port}/auth/twitch/callback`;
const clientId = process.env.TWITCH_CLIENT_ID?.trim() ?? '';
const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim() ?? '';
const debugCommands = process.env.CHATIRL_ALLOW_DEBUG_COMMANDS === 'true';
const tokenPath = resolve('.chatirl', 'twitch-token.json');
const oauthStates = new Map<string, number>();
const clients = new Set<WebSocket>();

let twitchStatus: TwitchStatus = {
  connected: false,
  broadcasterLogin: null,
  error:
    clientId && clientSecret
      ? null
      : 'Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env.',
};

function broadcast(message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function statusMessage(): ServerMessage {
  return {
    type: 'server.status',
    twitchConnected: twitchStatus.connected,
    broadcasterLogin: twitchStatus.broadcasterLogin,
  };
}

const participants = new ParticipantManager({ emit: broadcast });
const twitch =
  clientId && clientSecret
    ? new TwitchEventSub(
        { clientId, clientSecret, redirectUri },
        (message) => participants.handleChat(message),
        (status) => {
          twitchStatus = status;
          broadcast(statusMessage());
        },
        (token) => saveToken(token).catch(reportServerError),
      )
    : null;

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
webSockets.on('connection', (socket) => {
  clients.add(socket);
  socket.on('message', (data) => {
    try {
      const message: unknown = JSON.parse(data.toString());
      if (!isClientMessage(message)) return;
      if (message.type === 'client.ready') {
        socket.send(JSON.stringify(participants.snapshotMessage()));
        socket.send(JSON.stringify(statusMessage()));
      }
      // avatar.held is intentionally informational. !leave remains authoritative
      // and the Quest client forcibly releases held avatars before removing them.
    } catch {
      // Ignore malformed client messages; the next snapshot restores state.
    }
  });
  socket.on('close', () => clients.delete(socket));
});

const server = createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    reportServerError(error);
    sendJson(response, 500, { error: 'ChatIRL server error' });
  });
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSockets.emit('connection', webSocket, request);
  });
});

server.listen(port, host, async () => {
  console.log(`ChatIRL control server: http://localhost:${port}`);
  if (debugCommands) console.log('Local debug chat endpoint enabled.');
  if (twitch != null) {
    const savedToken = await loadToken();
    if (savedToken != null) {
      twitch.restore(savedToken).catch((error: unknown) => {
        twitchStatus = {
          connected: false,
          broadcasterLogin: savedToken.login,
          error: error instanceof Error ? error.message : String(error),
        };
      });
    }
  }
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
  if (request.method === 'GET' && url.pathname === '/') {
    sendHtml(response, controlPage());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/status') {
    sendJson(response, 200, {
      twitch: twitchStatus,
      acceptingJoins: participants.snapshotMessage().acceptingJoins,
      participantCount: participants.snapshot().length,
      participants: participants.snapshot().map(({ displayName, behavior }) => ({
        displayName,
        behavior,
      })),
      debugCommands,
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/auth/twitch') {
    if (twitch == null) {
      sendHtml(response, controlPage(), 503);
      return;
    }
    pruneOauthStates();
    const state = twitch.createState();
    oauthStates.set(state, Date.now() + 10 * 60_000);
    redirect(response, twitch.createAuthorizationUrl(state));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/auth/twitch/callback') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const expiresAt = state == null ? undefined : oauthStates.get(state);
    if (state == null || code == null || expiresAt == null || expiresAt < Date.now()) {
      sendJson(response, 400, { error: 'Invalid or expired Twitch authorization state.' });
      return;
    }
    oauthStates.delete(state);
    if (twitch == null) {
      sendJson(response, 503, { error: 'Twitch credentials are not configured.' });
      return;
    }
    await twitch.authorize(code);
    redirect(response, '/');
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/joins') {
    const body = await readJson(request);
    participants.setAcceptingJoins(body.accepting === true || body.accepting === 'true');
    redirect(response, '/');
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/clear') {
    participants.clear();
    redirect(response, '/');
    return;
  }
  if (request.method === 'POST' && url.pathname === '/debug/chat' && debugCommands) {
    const body = await readJson(request);
    if (
      typeof body.userId !== 'string' ||
      typeof body.displayName !== 'string' ||
      typeof body.text !== 'string'
    ) {
      sendJson(response, 400, { error: 'Expected userId, displayName, and text strings.' });
      return;
    }
    const message: ChatMessage = {
      userId: body.userId.slice(0, 64),
      displayName: body.displayName,
      text: body.text.slice(0, 500),
    };
    sendJson(response, 200, { accepted: participants.handleChat(message) });
    return;
  }
  sendJson(response, 404, { error: 'Not found' });
}

function controlPage(): string {
  const configured = twitch != null;
  const connected = twitchStatus.connected;
  const statusText = connected
    ? `Connected as ${escapeHtml(twitchStatus.broadcasterLogin ?? 'streamer')}`
    : escapeHtml(twitchStatus.error ?? 'Waiting for Twitch authorization.');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatIRL Streamer Control</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;background:#071318;color:#edfafa}h1{margin-bottom:4px}.card{background:#10262d;border:1px solid #24515b;border-radius:16px;padding:20px;margin:18px 0}button,a.button{display:inline-block;border:0;border-radius:9px;padding:11px 15px;margin:4px 6px 4px 0;background:#2ed7c4;color:#061416;font-weight:700;text-decoration:none;cursor:pointer}.secondary{background:#dbe8e9!important}.danger{background:#ff7b72!important}code{color:#6ef1df}small{color:#aac4c8}.ok{color:#62e6b2}.warn{color:#ffc76c}</style></head>
<body><h1>ChatIRL</h1><small>Local streamer control · Phase 2</small>
<section class="card"><h2>Twitch</h2><p class="${connected ? 'ok' : 'warn'}">${statusText}</p>
${configured ? '<a class="button" href="/auth/twitch">Authorize / reconnect Twitch</a>' : '<p>Create <code>.env</code> from <code>.env.example</code>, add your Twitch app credentials, and restart this server.</p>'}</section>
<section class="card"><h2>Session</h2><p><strong>${participants.snapshot().length}/10</strong> viewer avatars active.</p>
<form method="post" action="/admin/joins"><input type="hidden" name="accepting" value="true"><button type="submit">Allow joins</button></form>
<form method="post" action="/admin/joins"><input type="hidden" name="accepting" value="false"><button class="secondary" type="submit">Pause joins</button></form>
<form method="post" action="/admin/clear"><button class="danger" type="submit">Clear avatars</button></form></section>
<section class="card"><h2>Viewer commands</h2><p><code>!join</code> · <code>!run</code> · <code>!wave</code> · <code>!dance</code> · <code>!jump</code> · <code>!leave</code></p><p><small>Each command controls only the sender's avatar. <code>!leave</code> bypasses cooldowns and forcibly releases a held avatar.</small></p></section>
</body></html>`;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type'] ?? '';
  let raw = '';
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 16_384) throw new Error('Request body is too large');
    raw += value.toString('utf8');
  }
  if (contentType.includes('application/json')) {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

async function saveToken(token: TwitchToken): Promise<void> {
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(token), { encoding: 'utf8', mode: 0o600 });
}

async function loadToken(): Promise<TwitchToken | null> {
  try {
    return JSON.parse(await readFile(tokenPath, 'utf8')) as TwitchToken;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') reportServerError(error);
    return null;
  }
}

function pruneOauthStates(): void {
  const now = Date.now();
  for (const [state, expiresAt] of oauthStates) {
    if (expiresAt < now) oauthStates.delete(state);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { Location: location });
  response.end();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 && value < 65_536 ? value : fallback;
}

function reportServerError(error: unknown): void {
  console.error(error instanceof Error ? error.message : error);
}

function shutdown(): void {
  twitch?.disconnect();
  participants.clear();
  for (const client of clients) client.close(1001, 'ChatIRL server stopping');
  webSockets.close();
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
