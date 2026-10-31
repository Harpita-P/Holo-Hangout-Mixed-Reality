import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { isClientMessage, type ServerMessage } from '../shared/protocol.js';
import { ParticipantManager, type ChatMessage } from './participant-manager.js';
import { HangoutMomentsService } from './hangout-moments.js';
import { NativeCaptureReceiver } from './native-capture-receiver.js';
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
const momentsPath = resolve('.chatirl', 'hangout-moments.json');
const oauthStates = new Map<string, number>();
const clients = new Set<WebSocket>();
const dashboardCsrfToken = randomBytes(24).toString('base64url');

let twitchStatus: TwitchStatus = {
  connected: false,
  broadcasterLogin: null,
  clipsAuthorized: false,
  error:
    clientId && clientSecret
      ? null
      : 'Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env.',
};
let twitch: TwitchEventSub | null = null;

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

const participants = new ParticipantManager({
  emit: broadcast,
  onRealViewerJoined: (participant) => {
    const abilities = participant.supportedCommands
      .filter((command) => command !== '!join' && command !== '!leave')
      .join(' ');
    twitch?.sendChatMessage(
      `@${participant.displayName} joined HoloHangout as ${participant.monsterName}! Abilities: ${abilities}`,
    );
  },
});
const captureReceiver = new NativeCaptureReceiver({
  enabled: process.env.QUEST_CAPTURE_ENABLED === 'true',
  autoStart: process.env.QUEST_CAPTURE_AUTOSTART !== 'false',
  autoConfigureUsb: process.env.QUEST_CAPTURE_ADB_AUTOCONFIGURE === 'true',
  host: '127.0.0.1',
  inputPort: numberFromEnv('QUEST_CAPTURE_PORT', 49152),
  obsPort: numberFromEnv('QUEST_CAPTURE_OBS_UDP_PORT', 49153),
  webPort: numberFromEnv('CHATIRL_HTTPS_PORT', 8081),
  ffmpegBinary: process.env.FFMPEG_BIN?.trim() || 'ffmpeg',
  stallThresholdMs: boundedIntegerFromEnv(
    'QUEST_CAPTURE_STALL_THRESHOLD_MS',
    3000,
    1000,
    30_000,
  ),
});
const obs = new ObsController(
  {
    enabled: process.env.OBS_ENABLED === 'true',
    url: process.env.OBS_WEBSOCKET_URL?.trim() || 'ws://127.0.0.1:4455',
    password: process.env.OBS_WEBSOCKET_PASSWORD ?? '',
    sceneName: process.env.OBS_SCENE_NAME?.trim() || 'ChatIRL Live',
    nativeCaptureSourceName:
      process.env.OBS_NATIVE_CAPTURE_SOURCE_NAME?.trim() || 'Quest Capture Feed',
    fallbackCaptureSourceName: optionalString(
      process.env.OBS_FALLBACK_CAPTURE_SOURCE_NAME ??
        process.env.OBS_CAPTURE_SOURCE_NAME ??
        'MQDH Cast',
    ),
    microphoneSourceName: optionalString(process.env.OBS_MIC_SOURCE_NAME),
    microphoneSyncOffsetMs: boundedIntegerFromEnv(
      'OBS_MIC_SYNC_OFFSET_MS',
      0,
      0,
      5000,
    ),
  },
  () => undefined,
  undefined,
  () => captureReceiver.status(),
);
twitch =
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
const moments = new HangoutMomentsService(
  twitch,
  momentsPath,
  () => undefined,
  (clip) => broadcast({ type: 'hangout.moment', clipId: clip.id }),
);

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
webSockets.on('connection', (socket) => {
  clients.add(socket);
  socket.on('message', (data) => {
    try {
      const message: unknown = JSON.parse(data.toString());
      if (!isClientMessage(message)) return;
      if (message.type === 'client.ready') {
        socket.send(JSON.stringify(participants.snapshotMessage()));
        socket.send(JSON.stringify(participants.leaderboardMessage()));
        socket.send(JSON.stringify(statusMessage()));
      }
      if (message.type === 'challenge.completed') {
        void moments.completeChallenge(message.challengeId).catch(reportServerError);
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
      error instanceof HttpError ? error.message : 'HoloHangout server error';
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
  console.log(`HoloHangout local control server: http://localhost:${port}`);
  if (debugCommands) console.log('Local debug chat endpoint enabled.');
  obs.start();
  if (captureReceiver.status().enabled && captureReceiver.status().autoStart) {
    captureReceiver.start().catch(reportServerError);
  }
  await moments.load();
  if (twitch != null) {
    const savedToken = await loadToken();
    if (savedToken != null) {
      twitch.restore(savedToken).catch((error: unknown) => {
        twitchStatus = {
          connected: false,
          broadcasterLogin: savedToken.login,
          clipsAuthorized: false,
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
    const realParticipants = participants.snapshot().filter(({ isBot }) => !isBot);
    sendJson(response, 200, {
      twitch: twitchStatus,
      acceptingJoins: participants.snapshotMessage().acceptingJoins,
      participantCount: realParticipants.length,
      participants: realParticipants.map(
        ({ displayName, behavior, monsterName, monsterCategory, supportedCommands }) => ({
          displayName,
          behavior,
          monsterName,
          monsterCategory,
          supportedCommands,
        }),
      ),
      obs: obsStatus,
      capture: captureReceiver.status(),
      moments: moments.status(),
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
  if (request.method === 'GET' && url.pathname === '/demo/status') {
    sendJson(response, 200, participants.demoStatus());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/demo/on') {
    sendJson(response, 200, participants.setDemoMode(true));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/demo/off') {
    sendJson(response, 200, participants.setDemoMode(false));
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
  if (request.method === 'POST' && url.pathname === '/admin/obs/capture/native') {
    requireDashboardToken(await readJson(request));
    await sendObsOperation(response, () => obs.selectCapture('native'));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/obs/capture/mqdh') {
    requireDashboardToken(await readJson(request));
    await sendObsOperation(response, () => obs.selectCapture('mqdh'));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/capture/start') {
    requireDashboardToken(await readJson(request));
    await sendCaptureOperation(response, () => captureReceiver.start());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/capture/restart') {
    requireDashboardToken(await readJson(request));
    await sendCaptureOperation(response, () => captureReceiver.restart());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/capture/stop') {
    requireDashboardToken(await readJson(request));
    await sendCaptureOperation(response, () => captureReceiver.stop());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/capture/usb') {
    requireDashboardToken(await readJson(request));
    await sendCaptureOperation(response, () => captureReceiver.configureUsb());
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
  if (request.method === 'POST' && url.pathname === '/admin/moments/auto') {
    const body = await readJson(request);
    requireDashboardToken(body);
    sendJson(response, 200, {
      ok: true,
      moments: await moments.setAutoClipEnabled(body.enabled === true),
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/moments/clip') {
    requireDashboardToken(await readJson(request));
    sendJson(response, 200, { ok: true, moments: await moments.createManualMoment() });
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
<title>HoloHangout Streamer Control</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:840px;margin:40px auto;padding:0 20px;background:#071318;color:#edfafa}h1{margin-bottom:4px}h2{margin-top:0}.card{background:#10262d;border:1px solid #24515b;border-radius:16px;padding:20px;margin:18px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.check,.participant{padding:10px;border-radius:9px;background:#0a1c21}.participant{margin-top:8px}.participant strong{display:block}.participant code{font-size:12px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;background:#ff7b72}.dot.ok{background:#62e6b2}.dot.warn{background:#ffc76c}button,a.button{display:inline-block;border:0;border-radius:9px;padding:11px 15px;margin:4px 6px 4px 0;background:#2ed7c4;color:#061416;font-weight:700;text-decoration:none;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}.secondary{background:#dbe8e9!important}.danger{background:#ff7b72!important}.live{background:#ff4f64!important;color:#fff!important}code{color:#6ef1df}small,.muted{color:#aac4c8}.ok{color:#62e6b2}.warn{color:#ffc76c}.error{color:#ff9b93}.actions{margin-top:14px}</style></head>
<body><h1>HoloHangout</h1><small>Local streamer control · Live broadcast</small>
<section class="card"><h2>Twitch chat</h2><p id="twitch-status" class="${connected ? 'ok' : 'warn'}">${statusText}</p>
${configured ? '<a class="button" href="/auth/twitch">Authorize / reconnect Twitch</a>' : '<p>Create <code>.env</code> from <code>.env.example</code>, add your Twitch app credentials, and restart this server.</p>'}</section>
<section class="card"><h2>Native Quest capture <small>preferred</small></h2><div class="grid">
<div class="check"><span id="receiver-dot" class="dot"></span><strong>Mac receiver</strong><div id="receiver-status" class="muted">Checking…</div></div>
<div class="check"><span id="quest-dot" class="dot"></span><strong>Quest connection</strong><div id="quest-status" class="muted">Checking…</div></div>
<div class="check"><span id="video-dot" class="dot"></span><strong>Encoded video</strong><div id="video-status" class="muted">Checking…</div></div>
<div class="check"><span id="usb-dot" class="dot"></span><strong>USB transport</strong><div id="usb-status" class="muted">Checking…</div></div></div>
<div class="actions"><button id="capture-usb">Configure USB</button><button id="capture-restart" class="secondary">Start / Restart Receiver</button><button id="capture-stop" class="danger">Stop Receiver</button></div>
<p><small>Quest still requires <strong>Start Capture → Entire View</strong> approval for every capture session. HoloHangout monitors encoded byte flow; it cannot prove pixel-to-pixel motion if a compositor sends valid repeated frames.</small></p></section>
<section class="card"><h2>Broadcast</h2><div class="grid">
<div class="check"><span id="obs-dot" class="dot"></span><strong>OBS</strong><div id="obs-status" class="muted">Checking…</div></div>
<div class="check"><span id="scene-dot" class="dot"></span><strong>Scene</strong><div id="scene-status" class="muted">Checking…</div></div>
<div class="check"><span id="capture-dot" class="dot"></span><strong>Capture source</strong><div id="capture-status" class="muted">Checking…</div></div>
<div class="check"><span id="mic-dot" class="dot"></span><strong>Microphone</strong><div id="mic-status" class="muted">Checking…</div></div></div>
<p id="stream-status" class="warn">Not streaming</p><p id="broadcast-error" class="error"></p>
<div class="actions"><button id="use-native">Use Native Feed</button><button id="use-mqdh" class="secondary">Use MQDH Fallback</button><button id="obs-reconnect" class="secondary">Reconnect OBS</button><button id="start-stream" class="live" disabled>Start Stream</button><button id="stop-stream" class="danger" disabled>Stop Stream</button></div>
<p><small>Native Quest Capture is preferred when its receiver and OBS Media Source are healthy. MQDH remains an enabled-source fallback. OBS owns the Twitch destination; HoloHangout never stores your stream key.</small></p></section>
<section class="card"><h2>Hangout Moments</h2><p id="moment-status" class="muted">Ready when Twitch is live.</p>
<div class="actions"><button id="moment-auto" class="secondary">Auto-Clip Moments: OFF</button><button id="moment-clip">Clip This Moment</button></div>
<div id="moment-list"><small>No moments clipped yet.</small></div>
<p><small>Verified Twitch clips appear here. Automatic clips run once after a completed 60-second blaster challenge, with a 5-minute cooldown.</small></p></section>
<section class="card"><h2>Session</h2><p><strong id="participant-count">${participants.demoStatus().realParticipantCount}/10</strong> viewer avatars active.</p>
<button id="allow-joins">Allow joins</button><button id="pause-joins" class="secondary">Pause joins</button><button id="clear-avatars" class="danger">Clear avatars</button><div id="participant-list"><small>No monsters have joined yet.</small></div></section>
<section class="card"><h2>Viewer commands</h2><p><strong>Big</strong><br><code>!run · !jump · !wave · !duck · !punch · !yes · !no</code></p><p><strong>Blob</strong><br><code>!dance · !jump · !bite · !walk · !yes · !no</code></p><p><strong>Flying</strong><br><code>!fly · !headbutt · !punch · !yes · !no</code></p><p><small>Every monster supports <code>!join</code>, <code>!blast</code>, and <code>!leave</code>. Commands control only the sender's monster; unsupported commands are ignored. <code>!leave</code> forcibly releases a held monster.</small></p></section>
<script>
const csrfToken=${csrfToken};let latest=null;const byId=(id)=>document.getElementById(id);
function dot(id,state,warning=false){const element=byId(id);element.className='dot'+(state?' ok':warning?' warn':'');}
function renderParticipants(items){renderMoments(latest.moments,latest.twitch);const root=byId('participant-list');root.replaceChildren();if(!items.length){const empty=document.createElement('small');empty.textContent='No monsters have joined yet.';root.append(empty);return;}for(const item of items){const row=document.createElement('div');row.className='participant';const title=document.createElement('strong');title.textContent=item.displayName+' · '+item.monsterName;const meta=document.createElement('small');meta.textContent=item.monsterCategory.toUpperCase()+' · '+item.behavior;const commands=document.createElement('code');commands.textContent=item.supportedCommands.join(' · ');row.append(title,meta,document.createElement('br'),commands);root.append(row);}}
function renderMoments(value,twitch){byId('moment-status').textContent=value.message;byId('moment-status').className=value.state==='ready'?'ok':value.state==='failed'?'error':value.state==='unavailable'?'warn':'muted';byId('moment-auto').textContent='Auto-Clip Moments: '+(value.autoClipEnabled?'ON':'OFF');byId('moment-auto').className=value.autoClipEnabled?'':'secondary';byId('moment-clip').disabled=value.state==='creating'||!twitch.connected||!twitch.clipsAuthorized;const root=byId('moment-list');root.replaceChildren();if(!value.recent.length){const empty=document.createElement('small');empty.textContent='No moments clipped yet.';root.append(empty);return;}for(const clip of value.recent){const row=document.createElement('div');row.className='participant';const link=document.createElement('a');link.href=clip.url;link.target='_blank';link.rel='noopener';link.textContent=clip.title||'HoloHangout Moment';const meta=document.createElement('small');meta.textContent=new Date(clip.createdAt).toLocaleString();row.append(link,document.createElement('br'),meta);root.append(row);}}
function render(state){latest=state;const twitch=state.twitch;byId('twitch-status').textContent=twitch.connected?'Connected as '+(twitch.broadcasterLogin||'streamer'):(twitch.error||'Twitch disconnected');byId('twitch-status').className=twitch.connected?'ok':'warn';byId('participant-count').textContent=state.participantCount+'/10';renderParticipants(state.participants);const capture=state.capture;dot('receiver-dot',capture.listening,capture.enabled);byId('receiver-status').textContent=capture.listening?'Listening on TCP '+capture.inputPort:capture.enabled?'Stopped':'Disabled in .env';dot('quest-dot',capture.receiverConnected,capture.listening);byId('quest-status').textContent=capture.receiverConnected?'Connected'+(capture.reconnectCount?' · '+capture.reconnectCount+' reconnect(s)':''):capture.listening?'Waiting for Start Capture':'Receiver not running';dot('video-dot',capture.videoActive,capture.receiverConnected);byId('video-status').textContent=capture.stalled?'STALLED · '+capture.message:capture.videoActive?capture.bitrateMbps.toFixed(2)+' Mbps · active':capture.message;dot('usb-dot',capture.adbConfigured,capture.enabled);byId('usb-status').textContent=capture.adbConfigured?'ADB reverse ready':'Select Configure USB';byId('capture-usb').disabled=!capture.enabled;byId('capture-restart').disabled=!capture.enabled;byId('capture-stop').disabled=!capture.listening;const obs=state.obs;dot('obs-dot',obs.connected,obs.enabled);byId('obs-status').textContent=obs.connected?'Connected · OBS '+(obs.obsVersion||''):obs.enabled?'Disconnected':'Disabled in .env';dot('scene-dot',obs.targetSceneAvailable);byId('scene-status').textContent=obs.targetSceneAvailable?obs.targetScene+' ready':'Need scene: '+obs.targetScene;dot('capture-dot',obs.captureHealthy,obs.captureMode==='mqdh');byId('capture-status').textContent=obs.captureMode==='native'?'Native · '+obs.captureSourceName+' · '+obs.captureHealthReason:obs.captureMode==='mqdh'?'Fallback · '+obs.captureSourceName+' · verify OBS motion':obs.captureHealthReason;dot('mic-dot',obs.microphoneSourceAvailable===true,obs.microphoneSourceName===null);byId('mic-status').textContent=obs.microphoneSourceName===null?'Not checked (optional)':obs.microphoneSourceAvailable?obs.microphoneSourceName+' · delay '+obs.microphoneSyncOffsetMs+' ms':'Need source: '+obs.microphoneSourceName;byId('stream-status').textContent=obs.streaming?'LIVE · '+obs.outputTimecode:obs.reconnecting?'OBS reconnecting…':'Not streaming';byId('stream-status').className=obs.streaming?'error':'warn';byId('broadcast-error').textContent=obs.error||(capture.enabled&&capture.error?capture.error:'');byId('use-native').disabled=!obs.connected||!capture.videoActive;byId('use-mqdh').disabled=!obs.connected||!obs.fallbackCaptureSourceName;byId('obs-reconnect').disabled=!obs.enabled;byId('start-stream').disabled=!obs.ready||obs.streaming||!twitch.connected;byId('stop-stream').disabled=!obs.connected||!obs.streaming;}
async function refresh(){try{const response=await fetch('/status',{cache:'no-store'});render(await response.json());}catch(error){byId('broadcast-error').textContent='Dashboard status unavailable: '+error.message;}}
async function action(path,body={}){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,csrfToken})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed');await refresh();return result;}
byId('moment-auto').onclick=()=>action('/admin/moments/auto',{enabled:!latest.moments.autoClipEnabled}).catch((error)=>byId('moment-status').textContent=error.message);byId('moment-clip').onclick=()=>action('/admin/moments/clip').catch((error)=>byId('moment-status').textContent=error.message);
byId('capture-usb').onclick=()=>action('/admin/capture/usb').catch((error)=>byId('broadcast-error').textContent=error.message);byId('capture-restart').onclick=()=>action('/admin/capture/restart').catch((error)=>byId('broadcast-error').textContent=error.message);byId('capture-stop').onclick=()=>action('/admin/capture/stop').catch((error)=>byId('broadcast-error').textContent=error.message);byId('use-native').onclick=()=>action('/admin/obs/capture/native').catch((error)=>byId('broadcast-error').textContent=error.message);byId('use-mqdh').onclick=()=>action('/admin/obs/capture/mqdh').catch((error)=>byId('broadcast-error').textContent=error.message);byId('obs-reconnect').onclick=()=>action('/admin/obs/reconnect').catch((error)=>byId('broadcast-error').textContent=error.message);byId('start-stream').onclick=()=>{if(confirm('Start the Twitch livestream using the current OBS output settings?'))action('/admin/stream/start').catch((error)=>byId('broadcast-error').textContent=error.message);};byId('stop-stream').onclick=()=>action('/admin/stream/stop').catch((error)=>byId('broadcast-error').textContent=error.message);byId('allow-joins').onclick=()=>action('/admin/joins',{accepting:true});byId('pause-joins').onclick=()=>action('/admin/joins',{accepting:false});byId('clear-avatars').onclick=()=>{if(confirm('Remove all viewer avatars?'))action('/admin/clear');};refresh();setInterval(refresh,1500);
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

async function sendCaptureOperation(
  response: ServerResponse,
  operation: () => Promise<ReturnType<NativeCaptureReceiver['status']>>,
): Promise<void> {
  try {
    sendJson(response, 200, { ok: true, capture: await operation() });
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
  captureReceiver.stop().catch(reportServerError);
  participants.clear();
  for (const client of clients) client.close(1001, 'HoloHangout server stopping');
  webSockets.close();
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
