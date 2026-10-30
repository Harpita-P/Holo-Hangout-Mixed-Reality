import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { isClientMessage, type ServerMessage } from '../shared/protocol.js';
import { ParticipantManager, type ChatMessage } from './participant-manager.js';
import { ObsController } from './obs-controller.js';
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
const dashboardCsrfToken = randomBytes(24).toString('base64url');

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
const obs = new ObsController({
  enabled: process.env.OBS_ENABLED === 'true',
  url: process.env.OBS_WEBSOCKET_URL?.trim() || 'ws://127.0.0.1:4455',
  password: process.env.OBS_WEBSOCKET_PASSWORD ?? '',
  sceneName: process.env.OBS_SCENE_NAME?.trim() || 'ChatIRL Live',
  captureSourceName: process.env.OBS_CAPTURE_SOURCE_NAME?.trim() || 'MQDH Cast',
  microphoneSourceName: optionalString(process.env.OBS_MIC_SOURCE_NAME),
  microphoneSyncOffsetMs: boundedIntegerFromEnv('OBS_MIC_SYNC_OFFSET_MS', 0, 0, 5000),
});
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
    const status = error instanceof HttpError ? error.status : 500;
    const message =
      error instanceof HttpError ? error.message : 'ChatIRL server error';
    sendJson(response, status, { error: message });
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
  obs.start();
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
    const obsStatus = obs.status().connected
      ? await obs.refresh().catch(() => obs.status())
      : obs.status();
    sendJson(response, 200, {
      twitch: twitchStatus,
      acceptingJoins: participants.snapshotMessage().acceptingJoins,
      participantCount: participants.snapshot().length,
      participants: participants.snapshot().map(({ displayName, behavior }) => ({
        displayName,
        behavior,
      })),
      obs: obsStatus,
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
    requireDashboardToken(body);
    participants.setAcceptingJoins(body.accepting === true || body.accepting === 'true');
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/clear') {
    requireDashboardToken(await readJson(request));
    participants.clear();
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/obs/reconnect') {
    requireDashboardToken(await readJson(request));
    await sendObsOperation(response, () => obs.reconnect());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/stream/start') {
    requireDashboardToken(await readJson(request));
    if (!twitchStatus.connected) {
      sendJson(response, 409, {
        error: 'Twitch chat is not connected. Reauthorize Twitch before going live.',
      });
      return;
    }
    await sendObsOperation(response, () => obs.startStream());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/stream/stop') {
    requireDashboardToken(await readJson(request));
    await sendObsOperation(response, () => obs.stopStream());
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
  const csrfToken = JSON.stringify(dashboardCsrfToken);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatIRL Streamer Control</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:840px;margin:40px auto;padding:0 20px;background:#071318;color:#edfafa}h1{margin-bottom:4px}h2{margin-top:0}.card{background:#10262d;border:1px solid #24515b;border-radius:16px;padding:20px;margin:18px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.check{padding:10px;border-radius:9px;background:#0a1c21}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;background:#ff7b72}.dot.ok{background:#62e6b2}.dot.warn{background:#ffc76c}button,a.button{display:inline-block;border:0;border-radius:9px;padding:11px 15px;margin:4px 6px 4px 0;background:#2ed7c4;color:#061416;font-weight:700;text-decoration:none;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}.secondary{background:#dbe8e9!important}.danger{background:#ff7b72!important}.live{background:#ff4f64!important;color:#fff!important}code{color:#6ef1df}small,.muted{color:#aac4c8}.ok{color:#62e6b2}.warn{color:#ffc76c}.error{color:#ff9b93}.actions{margin-top:14px}</style></head>
<body><h1>ChatIRL</h1><small>Local streamer control · Live broadcast</small>
<section class="card"><h2>Twitch chat</h2><p id="twitch-status" class="${connected ? 'ok' : 'warn'}">${statusText}</p>
${configured ? '<a class="button" href="/auth/twitch">Authorize / reconnect Twitch</a>' : '<p>Create <code>.env</code> from <code>.env.example</code>, add your Twitch app credentials, and restart this server.</p>'}</section>
<section class="card"><h2>Broadcast</h2><div class="grid">
<div class="check"><span id="obs-dot" class="dot"></span><strong>OBS</strong><div id="obs-status" class="muted">Checking…</div></div>
<div class="check"><span id="scene-dot" class="dot"></span><strong>Scene</strong><div id="scene-status" class="muted">Checking…</div></div>
<div class="check"><span id="capture-dot" class="dot"></span><strong>MQDH capture</strong><div id="capture-status" class="muted">Checking…</div></div>
<div class="check"><span id="mic-dot" class="dot"></span><strong>Microphone</strong><div id="mic-status" class="muted">Checking…</div></div></div>
<p id="stream-status" class="warn">Not streaming</p><p id="broadcast-error" class="error"></p>
<div class="actions"><button id="obs-reconnect" class="secondary">Reconnect OBS</button><button id="start-stream" class="live" disabled>Start Stream</button><button id="stop-stream" class="danger" disabled>Stop Stream</button></div>
<p><small>Before starting, confirm the MQDH cast window visibly contains passthrough, hands, and avatars. OBS owns the Twitch stream destination; ChatIRL never stores your stream key.</small></p></section>
<section class="card"><h2>Session</h2><p><strong id="participant-count">${participants.snapshot().length}/10</strong> viewer avatars active.</p>
<button id="allow-joins">Allow joins</button><button id="pause-joins" class="secondary">Pause joins</button><button id="clear-avatars" class="danger">Clear avatars</button></section>
<section class="card"><h2>Viewer commands</h2><p><code>!join</code> · <code>!run</code> · <code>!wave</code> · <code>!dance</code> · <code>!jump</code> · <code>!leave</code></p><p><small>Each command controls only the sender's avatar. <code>!leave</code> bypasses cooldowns and forcibly releases a held avatar.</small></p></section>
<script>
const csrfToken=${csrfToken};let latest=null;const byId=(id)=>document.getElementById(id);
function dot(id,state,warning=false){const element=byId(id);element.className='dot'+(state?' ok':warning?' warn':'');}
function render(state){latest=state;const twitch=state.twitch;byId('twitch-status').textContent=twitch.connected?'Connected as '+(twitch.broadcasterLogin||'streamer'):(twitch.error||'Twitch disconnected');byId('twitch-status').className=twitch.connected?'ok':'warn';byId('participant-count').textContent=state.participantCount+'/10';const obs=state.obs;dot('obs-dot',obs.connected,obs.enabled);byId('obs-status').textContent=obs.connected?'Connected · OBS '+(obs.obsVersion||''):obs.enabled?'Disconnected':'Disabled in .env';dot('scene-dot',obs.targetSceneAvailable);byId('scene-status').textContent=obs.targetSceneAvailable?obs.targetScene+' ready':'Need scene: '+obs.targetScene;dot('capture-dot',obs.captureSourceAvailable);byId('capture-status').textContent=obs.captureSourceAvailable?obs.captureSourceName+' ready':'Need source: '+obs.captureSourceName;dot('mic-dot',obs.microphoneSourceAvailable===true,obs.microphoneSourceName===null);byId('mic-status').textContent=obs.microphoneSourceName===null?'Not checked (optional)':obs.microphoneSourceAvailable?obs.microphoneSourceName+' · delay '+obs.microphoneSyncOffsetMs+' ms':'Need source: '+obs.microphoneSourceName;byId('stream-status').textContent=obs.streaming?'LIVE · '+obs.outputTimecode:obs.reconnecting?'OBS reconnecting…':'Not streaming';byId('stream-status').className=obs.streaming?'error':'warn';byId('broadcast-error').textContent=obs.error||'';byId('obs-reconnect').disabled=!obs.enabled;byId('start-stream').disabled=!obs.ready||obs.streaming||!twitch.connected;byId('stop-stream').disabled=!obs.connected||!obs.streaming;}
async function refresh(){try{const response=await fetch('/status',{cache:'no-store'});render(await response.json());}catch(error){byId('broadcast-error').textContent='Dashboard status unavailable: '+error.message;}}
async function action(path,body={}){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,csrfToken})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed');await refresh();return result;}
byId('obs-reconnect').onclick=()=>action('/admin/obs/reconnect').catch((error)=>byId('broadcast-error').textContent=error.message);byId('start-stream').onclick=()=>{if(confirm('Start the Twitch livestream using the current OBS output settings?'))action('/admin/stream/start').catch((error)=>byId('broadcast-error').textContent=error.message);};byId('stop-stream').onclick=()=>action('/admin/stream/stop').catch((error)=>byId('broadcast-error').textContent=error.message);byId('allow-joins').onclick=()=>action('/admin/joins',{accepting:true});byId('pause-joins').onclick=()=>action('/admin/joins',{accepting:false});byId('clear-avatars').onclick=()=>{if(confirm('Remove all viewer avatars?'))action('/admin/clear');};refresh();setInterval(refresh,1500);
</script></body></html>`;
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

function requireDashboardToken(body: Record<string, unknown>): void {
  if (body.csrfToken !== dashboardCsrfToken) {
    throw new HttpError(403, 'Invalid dashboard request token. Reload the control page.');
  }
}

async function sendObsOperation(
  response: ServerResponse,
  operation: () => Promise<ReturnType<ObsController['status']>>,
): Promise<void> {
  try {
    sendJson(response, 200, { ok: true, obs: await operation() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(409, message);
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

function boundedIntegerFromEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function optionalString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function reportServerError(error: unknown): void {
  console.error(error instanceof Error ? error.message : error);
}

function shutdown(): void {
  twitch?.disconnect();
  obs.stop().catch(reportServerError);
  participants.clear();
  for (const client of clients) client.close(1001, 'ChatIRL server stopping');
  webSockets.close();
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
