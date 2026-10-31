import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { isClientMessage, type ServerMessage } from '../shared/protocol.js';
import { ParticipantManager, type ChatMessage } from './participant-manager.js';
import { NativeCaptureReceiver } from './native-capture-receiver.js';
import { ObsController } from './obs-controller.js';
import { CommunitySandbox, parseBuildCommand } from './community-sandbox.js';
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
let twitch: TwitchEventSub | null = null;

function broadcast(message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function handleChat(message: ChatMessage): boolean {
  const text = message.text.trim();
  const buildPrompt = parseBuildCommand(text);
  if (buildPrompt != null) return sandbox.submit(message.userId, message.displayName, buildPrompt);
  const accepted = participants.handleChat(message);
  if (/^!leave(?:\s|$)/iu.test(text)) sandbox.viewerLeft(message.userId);
  return accepted;
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
const sandbox = new CommunitySandbox({
  emit: broadcast,
  participant: (userId) => participants.participant(userId),
  apiKey: process.env.GEMINI_API_KEY?.trim() ?? '',
  model: process.env.GEMINI_VOXEL_MODEL?.trim() || 'gemini-3.5-flash-lite',
  generator: process.env.COMMUNITY_SANDBOX_GENERATOR === 'mock' ? 'mock' : 'gemini',
  sessionLimit: boundedIntegerFromEnv('COMMUNITY_SANDBOX_SESSION_LIMIT', 20, 1, 100),
  requestLifetimeMs: boundedIntegerFromEnv('COMMUNITY_SANDBOX_REQUEST_LIFETIME_MS', 15_000, 15_000, 180_000),
});
const captureReceiver = new NativeCaptureReceiver({
  enabled: process.env.QUEST_CAPTURE_ENABLED === 'true',
  autoStart: process.env.QUEST_CAPTURE_AUTOSTART !== 'false',
  autoConfigureUsb: process.env.QUEST_CAPTURE_ADB_AUTOCONFIGURE !== 'false',
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
    sceneName: process.env.OBS_SCENE_NAME?.trim() || 'HoloHangout Live',
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
        handleChat,
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
        socket.send(JSON.stringify(participants.leaderboardMessage()));
        socket.send(JSON.stringify(statusMessage()));
        socket.send(JSON.stringify(sandbox.snapshotMessage()));
      }
      if (message.type === 'avatar.held') sandbox.setHeld(message.userId, message.held);
      if (message.type === 'sandbox.approve') sandbox.approve(message.requestId, message.userId);
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
  console.log(`HoloHangout creator dashboard: http://localhost:${port}`);
  if (debugCommands) console.log('Local debug chat endpoint enabled.');
  obs.start();
  if (captureReceiver.status().enabled && captureReceiver.status().autoStart) {
    captureReceiver.start().catch(reportServerError);
  }
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
  if (request.method === 'GET' && url.pathname === '/creator-theme.css') {
    const stylesheet = await readFile(resolve('public', 'creator-theme.css'), 'utf8');
    response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    response.end(stylesheet);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/holohangout-logo.png') {
    const logo = await readFile(resolve('public', 'holohangout-logo.png'));
    response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
    response.end(logo);
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
      demo: participants.demoStatus(),
      sandbox: sandbox.dashboardStatus(),
      world: { connected: clients.size > 0, connectionCount: clients.size },
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
  if (request.method === 'POST' && url.pathname === '/admin/demo') {
    const body = await readJson(request);
    requireDashboardToken(body);
    sendJson(response, 200, participants.setDemoMode(body.enabled === true));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/sandbox/start') {
    requireDashboardToken(await readJson(request));
    sendJson(response, 200, { ok: true, sandbox: sandbox.start() });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/sandbox/stop') {
    requireDashboardToken(await readJson(request));
    sendJson(response, 200, { ok: true, sandbox: sandbox.stop() });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/sandbox/clear') {
    requireDashboardToken(await readJson(request));
    sendJson(response, 200, { ok: true, sandbox: sandbox.clearCreations() });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/admin/sandbox/mock-request') {
    const body = await readJson(request);
    requireDashboardToken(body);
    const bot = participants.snapshot().find(({ isBot }) => isBot);
    if (bot == null) throw new HttpError(409, 'Turn Bot Friendly Mode on first so a demo monster can request a build.');
    const prompt = typeof body.prompt === 'string' ? body.prompt : 'colorful dragon';
    if (!sandbox.submit(bot.userId, bot.displayName, prompt, true)) {
      throw new HttpError(409, 'Demo build request was not accepted. Start Sandbox or wait for the current request.');
    }
    sendJson(response, 200, { ok: true, sandbox: sandbox.status() });
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
    for (const participant of participants.snapshot()) sandbox.viewerLeft(participant.userId);
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
    sendJson(response, 200, { accepted: handleChat(message) });
    return;
  }
  sendJson(response, 404, { error: 'Not found' });
}

function controlPage(): string {
  const configured = twitch != null;
  const connected = twitchStatus.connected;
  const statusText = connected
    ? `@${escapeHtml(twitchStatus.broadcasterLogin ?? 'streamer')}`
    : 'Not connected';
  const csrfToken = JSON.stringify(dashboardCsrfToken);
  const localQuestUrl = `https://localhost:${numberFromEnv('CHATIRL_HTTPS_PORT', 8081)}/`;
  const questUrlJson = JSON.stringify(localQuestUrl);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HoloHangout Creator Dashboard</title><link rel="stylesheet" href="/creator-theme.css"></head>
<body><main class="shell">
<nav class="topbar"><div class="brand-lockup"><h1 class="visually-hidden">HoloHangout</h1><img class="brand-logo" src="/holohangout-logo.png" alt="HoloHangout"><p class="brand-tagline">Bring your Twitch community into mixed reality.</p></div></nav>
<h2 class="onboarding-heading">Launch a Shared Mixed Reality Experience for <span>Chat</span></h2>
<section class="landing-cta" aria-label="Get started with HoloHangout"><p>Bring your Twitch community into your world. Play, interact, and create together in mixed reality.</p><a class="button github-button" href="https://github.com/Harpita-P/Holo-Hangout-Mixed-Reality" target="_blank" rel="noopener noreferrer">Get Started on GitHub</a><small>Free, open-source setup and instructions for connecting Twitch, Meta Quest, and OBS.</small></section>
<nav class="stepper" aria-label="Getting started">
<a id="step-twitch" class="step" href="#connect-twitch"><span class="step-number" aria-hidden="true"></span><span class="step-content"><span class="step-label">STEP 1</span><strong>Connect Twitch</strong><small id="step-twitch-status">Checking…</small></span></a>
<a id="step-world" class="step" href="#enter-world"><span class="step-number" aria-hidden="true"></span><span class="step-content"><span class="step-label">STEP 2</span><strong>Enter Your World</strong><small id="step-world-status">Checking…</small></span></a>
<a id="step-stream" class="step" href="#go-live"><span class="step-number" aria-hidden="true"></span><span class="step-content"><span class="step-label">STEP 3</span><strong>Go Live on Twitch</strong><small id="step-stream-status">Checking…</small></span></a>
<a id="step-community" class="step" href="#community"><span class="step-number" aria-hidden="true"></span><span class="step-content"><span class="step-label">STEP 4</span><strong>Invite Your Viewers</strong><small id="step-community-status">Ready when you are</small></span></a>
</nav>
<section class="readiness visually-hidden" aria-label="Readiness overview">
<article><span class="readiness-icon">T</span><span><small>Twitch</small><strong id="overview-twitch">Checking…</strong></span></article>
<article><span class="readiness-icon">Q</span><span><small>Quest</small><strong id="overview-quest">Checking…</strong></span></article>
<article><span class="readiness-icon">●</span><span><small>Broadcast</small><strong id="overview-broadcast">Checking…</strong></span></article>
<article><span class="readiness-icon">♥</span><span><small>Viewers</small><strong id="overview-viewers">None yet</strong></span></article>
</section>
<section class="dashboard-section" aria-label="Setup"><div class="dashboard-grid">
<section id="connect-twitch" class="card feature-panel twitch-panel"><div class="card-header"><h3>Connect Twitch</h3></div><div id="twitch-account" class="account-highlight${connected ? ' connected' : ''}"><span class="account-identity"><span class="account-label">Twitch account</span><strong id="twitch-status" class="${connected ? 'ok' : 'warn'}">${statusText}</strong></span><span class="status-pill account-state"><span id="twitch-dot" class="dot"></span><span id="twitch-chip">Checking</span></span><span id="twitch-helper" class="visually-hidden">Checking your connection…</span></div>
${configured ? `<a class="button twitch-action" href="/auth/twitch">${connected ? 'Reconnect Twitch' : 'Connect Twitch'}</a>` : '<p class="callout warning">Twitch setup is incomplete. Add your Twitch app details in Settings, then restart HoloHangout.</p>'}</section>
<section id="enter-world" class="card feature-panel world-panel"><div class="card-header"><h3>Enter Your World</h3><span class="status-pill"><span id="world-dot" class="dot"></span><span id="world-status">Waiting for your headset</span></span></div>
<div class="url-row world-url"><code id="quest-url">${escapeHtml(localQuestUrl)}</code><button id="copy-world" class="secondary">Copy</button></div><div class="actions"><button id="capture-usb">Set Up Quest</button><button id="open-world" class="secondary">Open on This Computer</button></div><p id="world-usb-feedback" class="helper" aria-live="polite"></p>
<details><summary>How to open HoloHangout on Quest</summary><ol><li>Connect and unlock your Quest, then select <strong>Set Up Quest</strong>.</li><li>Open the copied link in Meta Quest Browser.</li><li>Accept the local certificate warning if it appears.</li><li>Select <strong>Enter AR</strong>.</li></ol></details></section>
<section id="go-live" class="card wide stream-card"><div class="card-header"><div class="panel-heading"><span class="panel-icon" aria-hidden="true">●</span><h3>Go Live on Twitch</h3></div><span id="stream-status" class="status-pill warn">Offline</span></div>
<div class="stream-summary"><article><span id="quest-dot" class="dot"></span><span><small>1. Quest Capture</small><strong id="capture-main-status">Checking…</strong></span></article><article><span id="obs-dot" class="dot"></span><span><small>2. OBS</small><strong id="obs-main-status">Checking…</strong></span></article><article><span id="stream-dot" class="dot"></span><span><small>3. Twitch Stream</small><strong id="stream-main-status">Offline</strong></span></article></div>
<div id="stream-guidance" class="guidance">Checking your streaming setup…</div><div class="actions stream-actions"><button id="start-stream" class="live" disabled>Start Stream</button><button id="stop-stream" class="danger" disabled>Stop Stream</button></div>
<details class="advanced"><summary>Advanced Streaming Settings</summary><ol><li>Open HoloHangout Capture on Quest and approve Entire View sharing.</li><li>Open the HoloHangout Live scene in OBS.</li></ol><div class="actions"><button id="capture-restart" class="secondary">Start / Restart Capture</button><button id="capture-stop" class="danger">Stop Capture</button><button id="use-native">Use Quest Capture Feed</button><button id="use-mqdh" class="secondary">Use MQDH Fallback</button><button id="obs-reconnect" class="secondary">Reconnect OBS</button></div><div class="diagnostics grid">
<div class="check"><span id="receiver-dot" class="dot"></span><strong>Local capture service</strong><div id="receiver-status" class="muted">Checking…</div></div><div class="check"><span id="video-dot" class="dot"></span><strong>Video activity</strong><div id="video-status" class="muted">Checking…</div></div><div class="check"><span id="usb-dot" class="dot"></span><strong>USB connection</strong><div id="usb-status" class="muted">Checking…</div></div><div class="check"><span id="scene-dot" class="dot"></span><strong>OBS scene</strong><div id="scene-status" class="muted">Checking…</div></div><div class="check"><span id="capture-dot" class="dot"></span><strong>Capture source</strong><div id="capture-status" class="muted">Checking…</div></div><div class="check"><span id="mic-dot" class="dot"></span><strong>Microphone</strong><div id="mic-status" class="muted">Checking…</div></div></div><div id="quest-status" class="visually-hidden"></div><div id="obs-status" class="visually-hidden"></div><p class="technical-error"><strong>Technical details</strong><code id="broadcast-error"></code></p></details></section>
</div></section>
<section class="dashboard-section" aria-labelledby="hangout-heading"><div class="section-heading"><h2 id="hangout-heading">Your Hangout</h2></div><div class="dashboard-grid experience-grid">
<section id="community" class="card community-panel"><div class="card-header"><h3>Your Community</h3><span class="status-pill join-command"><code>!join</code></span></div><div class="viewer-metric"><strong id="participant-count">0 / 10</strong><span>Viewers in Your World</span></div><div class="actions"><button id="allow-joins">Allow Joins</button><button id="pause-joins" class="secondary">Pause Joins</button></div><div id="participant-list" class="participant-list"></div><details><summary>Community Options</summary><button id="clear-avatars" class="danger">Clear Avatars</button></details></section>
<section id="sandbox-card" class="card experience-card sandbox-card"><div class="card-header"><h3>Community Sandbox</h3><span id="sandbox-status" class="status-pill">Inactive</span></div><div class="sandbox-summary"><span><small>Pending</small><strong id="sandbox-pending">0</strong></span><span><small>Creating</small><strong id="sandbox-generating">0</strong></span><span><small>Completed</small><strong id="sandbox-creations">0</strong></span></div><p id="sandbox-config" class="callout" hidden></p><div class="actions"><button id="sandbox-start">Start Sandbox</button><button id="sandbox-stop" class="secondary">Stop Sandbox</button></div><details><summary>Sandbox Settings</summary><p class="muted">Generation allowance: <span id="sandbox-allowance">20 / 20 remaining</span></p><p class="muted">Turn Bot Friendly Mode on, start Sandbox, then add a no-cost test request.</p><div class="url-row"><input id="sandbox-mock-prompt" maxlength="100" value="colorful dragon" aria-label="Mock build prompt"><button id="sandbox-mock" class="secondary">Add Test Request</button></div><div class="actions"><button id="sandbox-clear" class="danger">Clear Creations</button></div></details></section>
<section id="demo-card" class="card compact-card experience-card"><div class="card-header"><h3>Include Bots</h3><span id="demo-status" class="status-pill">Off</span></div><button id="demo-toggle" class="toggle-button secondary" aria-pressed="false">Turn Bot Friendly Mode On</button></section>
</div></section>
<section class="dashboard-section help-section" aria-labelledby="help-heading"><h2 id="help-heading" class="visually-hidden">Help and guides</h2><details class="card wide guides-panel"><summary class="guides-heading"><span class="panel-icon" aria-hidden="true">?</span><span><strong>Help &amp; Guides</strong><small>Viewer commands and setup help</small></span></summary><div class="guide-grid"><details><summary>Viewer Commands</summary><div class="featured-command"><code>!join</code><span>Join the world</span></div><div class="command-list"><div><strong>Everyone</strong><p><code>!join !leave !blast !support !like !fire</code></p></div><div><strong>Big monsters</strong><p><code>!run !jump !wave !duck !punch !yes !no</code></p></div><div><strong>Blob monsters</strong><p><code>!dance !jump !bite !walk !yes !no</code></p></div><div><strong>Flying monsters</strong><p><code>!fly !headbutt !punch !yes !no</code></p></div><div><strong>Community Sandbox</strong><p><code>!build &lt;idea&gt;</code></p></div></div></details><details><summary>Quest Setup Guide</summary><p>Connect and unlock your headset by USB, select <strong>Set Up Quest</strong>, then open the Quest link in Meta Quest Browser.</p></details><details><summary>OBS Setup Guide</summary><p>Open OBS, enable its WebSocket server, select <strong>HoloHangout Live</strong>, and confirm the Quest feed is moving.</p></details><details><summary>Troubleshooting</summary><ol><li>Confirm Quest Capture has permission to share Entire View.</li><li>Confirm OBS is open on the HoloHangout Live scene.</li><li>Open Advanced Streaming Settings to inspect the failing connection and reconnect it.</li></ol></details></div></details>
</section><p class="footer">HoloHangout runs locally on this computer. Your Twitch credentials and stream settings stay under your control.</p>
<script>
const csrfToken=${csrfToken};const questUrl=${questUrlJson};let latest=null;const byId=(id)=>document.getElementById(id);
function dot(id,state,warning=false){const element=byId(id);element.className='dot'+(state?' ok':warning?' warn':'');}
function renderParticipants(items){const root=byId('participant-list');root.replaceChildren();for(const item of items){const row=document.createElement('div');row.className='participant';const avatar=document.createElement('span');avatar.className='participant-avatar';avatar.textContent=item.displayName.slice(0,1).toUpperCase();const text=document.createElement('span');const title=document.createElement('strong');title.textContent=item.displayName;const meta=document.createElement('small');meta.textContent=item.monsterName+' · '+item.behavior; text.append(title,meta);row.append(avatar,text);root.append(row);}}
function renderSandbox(value,demo){byId('sandbox-status').textContent=value.active?'Active':'Inactive';byId('sandbox-status').className='status-pill '+(value.active?'ok':'');byId('sandbox-pending').textContent=String(value.pendingCount);byId('sandbox-generating').textContent=String(value.generatingCount);byId('sandbox-creations').textContent=String(value.creationCount);byId('sandbox-allowance').textContent=value.remainingAllowance+' of '+value.sessionLimit+' remaining';const config=byId('sandbox-config');const needsKey=value.generator!=='mock'&&!value.apiKeyConfigured;config.hidden=!needsKey&&!value.lastError;config.textContent=value.lastError||'Add your Gemini API key in local Settings before approving real creations.';config.className='callout warning';byId('sandbox-start').disabled=value.active;byId('sandbox-stop').disabled=!value.active;byId('sandbox-clear').disabled=value.creationCount===0;byId('sandbox-mock').disabled=!value.active||!demo.enabled;}
function setStep(id,state,label){const element=byId(id);element.className='step '+state;const status=element.querySelector('small');if(status)status.textContent=label;}
function renderCreatorExperience(state){const twitch=state.twitch;const capture=state.capture;const obs=state.obs;const viewerCount=state.participantCount;const captureReady=capture.videoActive&&!capture.stalled;const broadcastReady=obs.ready&&twitch.connected;const streamProblem=Boolean(obs.error||capture.error);
setStep('step-twitch',twitch.connected?'complete':'active waiting',twitch.connected?'Connected':'Waiting to connect');setStep('step-world',state.world.connected?'complete':twitch.connected?'active waiting':'upcoming waiting',state.world.connected?'Headset connected':twitch.connected?'Waiting for Quest':'Connect Twitch first');setStep('step-stream',obs.streaming?'complete':streamProblem?'active warning':state.world.connected?'active waiting':'upcoming waiting',obs.streaming?'You’re live':streamProblem?'Setup needs attention':broadcastReady?'Ready to stream':state.world.connected?'Waiting for OBS':'Complete earlier steps');setStep('step-community',viewerCount>0?'complete':obs.streaming?'active waiting':'upcoming waiting',viewerCount>0?viewerCount+' participating':obs.streaming?'Waiting for viewers':'Go live first');
byId('overview-twitch').textContent=twitch.connected?'Connected':'Not connected';byId('overview-quest').textContent=state.world.connected?'Connected':'Not connected';byId('overview-broadcast').textContent=obs.streaming?'Live':broadcastReady?'Ready':'Needs setup';byId('overview-viewers').textContent=viewerCount===0?'None yet':viewerCount+' of 10';
byId('twitch-status').textContent=twitch.connected?'@'+(twitch.broadcasterLogin||'streamer'):'Not connected';byId('twitch-helper').textContent=twitch.connected?'Connected':'Connect Twitch to continue.';byId('twitch-account').classList.toggle('connected',twitch.connected);byId('world-status').textContent=state.world.connected?'Headset connected':'Waiting for your headset';byId('participant-count').textContent=viewerCount+' / 10';byId('allow-joins').disabled=state.acceptingJoins;byId('pause-joins').disabled=!state.acceptingJoins;
byId('demo-toggle').textContent=state.demo.enabled?'Turn Bot Friendly Mode Off':'Turn Bot Friendly Mode On';byId('demo-toggle').setAttribute('aria-pressed',String(state.demo.enabled));
byId('sandbox-card').classList.toggle('active',state.sandbox.active);byId('demo-card').classList.toggle('active',state.demo.enabled);byId('go-live').classList.toggle('is-live',obs.streaming);
byId('capture-main-status').textContent=captureReady?'Capturing':capture.receiverConnected?'Waiting for video':'Not connected';byId('obs-main-status').textContent=obs.connected?obs.ready?'Ready':'Needs attention':'Not connected';byId('stream-main-status').textContent=obs.streaming?'Live':'Offline';dot('stream-dot',obs.streaming,broadcastReady);byId('stream-status').textContent=obs.streaming?'You’re Live!':broadcastReady?'Ready to Stream':'Offline';byId('stream-status').className='status-pill '+(obs.streaming?'live-status':broadcastReady?'ok':'warn');
let guidance='Everything looks ready. Start your stream when you’re ready.';if(obs.streaming)guidance='You’re live! Viewers can now watch and interact with your mixed-reality world.';else if(!twitch.connected)guidance='Connect Twitch before starting your stream.';else if(!capture.enabled)guidance='Quest Capture is turned off. Enable it in your local settings and restart HoloHangout.';else if(!capture.receiverConnected)guidance='Open HoloHangout Capture on Quest and approve screen sharing.';else if(!captureReady)guidance=capture.stalled?'Quest Capture stopped updating. Restart capture from Advanced Details.':'Waiting for video from your Quest.';else if(!obs.connected)guidance='OBS isn’t connected. Open OBS and make sure its WebSocket server is enabled.';else if(!obs.targetSceneAvailable)guidance='Open the HoloHangout Live scene in OBS, then reconnect.';else if(!obs.captureHealthy)guidance='OBS is connected, but the Quest feed is not active yet.';byId('stream-guidance').textContent=guidance;byId('stream-guidance').className='guidance '+(obs.streaming||broadcastReady?'success':'');if(capture.adbConfigured){byId('world-usb-feedback').textContent='Your Quest connection is ready. Open the Quest link in your headset.';byId('world-usb-feedback').className='helper ok';}}
function render(state){latest=state;const twitch=state.twitch;byId('twitch-status').textContent=twitch.connected?'Connected as '+(twitch.broadcasterLogin||'streamer'):(twitch.error||'Twitch disconnected');byId('twitch-status').className=twitch.connected?'ok':'warn';dot('twitch-dot',twitch.connected);byId('twitch-chip').textContent=twitch.connected?'Connected':'Not connected';dot('world-dot',state.world.connected);byId('world-status').textContent=state.world.connected?'Quest Browser connected':'Waiting for Quest Browser';byId('participant-count').textContent=state.participantCount+'/10';byId('demo-status').textContent=state.demo.enabled?'On · '+state.demo.botCount+' bots':'Off';byId('demo-toggle').textContent='Turn Bot Friendly Mode '+(state.demo.enabled?'Off':'On');renderParticipants(state.participants);const capture=state.capture;dot('receiver-dot',capture.listening,capture.enabled);byId('receiver-status').textContent=capture.listening?'Listening on TCP '+capture.inputPort:capture.enabled?'Stopped':'Disabled in .env';dot('quest-dot',capture.receiverConnected,capture.listening);byId('quest-status').textContent=capture.receiverConnected?'Connected'+(capture.reconnectCount?' · '+capture.reconnectCount+' reconnect(s)':''):capture.listening?'Waiting for Start Capture':'Receiver not running';dot('video-dot',capture.videoActive,capture.receiverConnected);byId('video-status').textContent=capture.stalled?'STALLED · '+capture.message:capture.videoActive?capture.bitrateMbps.toFixed(2)+' Mbps · active':capture.message;dot('usb-dot',capture.adbConfigured,capture.enabled);byId('usb-status').textContent=capture.adbConfigured?'ADB reverse ready':'Select Configure USB';if(capture.adbConfigured){byId('world-usb-feedback').textContent='USB forwarding is ready. Open the world in Quest Browser.';byId('world-usb-feedback').className='ok';}byId('capture-restart').disabled=!capture.enabled;byId('capture-stop').disabled=!capture.listening;const obs=state.obs;dot('obs-dot',obs.connected,obs.enabled);byId('obs-status').textContent=obs.connected?'Connected · OBS '+(obs.obsVersion||''):obs.enabled?'Disconnected':'Disabled in .env';dot('scene-dot',obs.targetSceneAvailable);byId('scene-status').textContent=obs.targetSceneAvailable?obs.targetScene+' ready':'Need scene: '+obs.targetScene;dot('capture-dot',obs.captureHealthy,obs.captureMode==='mqdh');byId('capture-status').textContent=obs.captureMode==='native'?'Native · '+obs.captureSourceName+' · '+obs.captureHealthReason:obs.captureMode==='mqdh'?'Fallback · '+obs.captureSourceName+' · verify OBS motion':obs.captureHealthReason;dot('mic-dot',obs.microphoneSourceAvailable===true,obs.microphoneSourceName===null);byId('mic-status').textContent=obs.microphoneSourceName===null?'Not checked (optional)':obs.microphoneSourceAvailable?obs.microphoneSourceName+' · delay '+obs.microphoneSyncOffsetMs+' ms':'Need source: '+obs.microphoneSourceName;byId('stream-status').textContent=obs.streaming?'LIVE · '+obs.outputTimecode:obs.reconnecting?'OBS reconnecting…':'Not streaming';byId('stream-status').className='status-pill '+(obs.streaming?'error':'warn');byId('broadcast-error').textContent=obs.error||(capture.enabled&&capture.error?capture.error:'');byId('use-native').disabled=!obs.connected||!capture.videoActive;byId('use-mqdh').disabled=!obs.connected||!obs.fallbackCaptureSourceName;byId('obs-reconnect').disabled=!obs.enabled;byId('start-stream').disabled=!obs.ready||obs.streaming||!twitch.connected;byId('stop-stream').disabled=!obs.connected||!obs.streaming;}
async function refresh(){try{const response=await fetch('/status',{cache:'no-store'});const state=await response.json();renderSandbox(state.sandbox,state.demo);render(state);renderCreatorExperience(state);}catch(error){byId('stream-guidance').textContent='The dashboard cannot reach HoloHangout right now. Keep this window open and restart HoloHangout if needed.';byId('broadcast-error').textContent=error.message;}}
async function action(path,body={}){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,csrfToken})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed');await refresh();return result;}
byId('capture-usb').onclick=async()=>{const button=byId('capture-usb');const feedback=byId('world-usb-feedback');button.disabled=true;button.textContent='Setting Up…';feedback.textContent='Checking your headset connection…';feedback.className='helper';try{await action('/admin/capture/usb');feedback.textContent='Your Quest is ready. Open the Quest link in Meta Quest Browser.';feedback.className='helper ok';}catch(error){feedback.textContent='Quest setup needs attention. Make sure the headset is connected, unlocked, and USB debugging is allowed.';feedback.className='helper error';byId('broadcast-error').textContent=error.message;}finally{button.disabled=false;button.textContent='Set Up Quest';}};byId('capture-restart').onclick=()=>action('/admin/capture/restart').catch((error)=>byId('broadcast-error').textContent=error.message);byId('capture-stop').onclick=()=>action('/admin/capture/stop').catch((error)=>byId('broadcast-error').textContent=error.message);byId('use-native').onclick=()=>action('/admin/obs/capture/native').catch((error)=>byId('broadcast-error').textContent=error.message);byId('use-mqdh').onclick=()=>action('/admin/obs/capture/mqdh').catch((error)=>byId('broadcast-error').textContent=error.message);byId('obs-reconnect').onclick=()=>action('/admin/obs/reconnect').catch((error)=>byId('broadcast-error').textContent=error.message);byId('start-stream').onclick=()=>{if(confirm('Start your Twitch livestream now?'))action('/admin/stream/start').catch((error)=>{byId('stream-guidance').textContent='Your stream could not start. Check Advanced Details for the technical error.';byId('broadcast-error').textContent=error.message;});};byId('stop-stream').onclick=()=>action('/admin/stream/stop').catch((error)=>byId('broadcast-error').textContent=error.message);byId('allow-joins').onclick=()=>action('/admin/joins',{accepting:true}).catch((error)=>byId('broadcast-error').textContent=error.message);byId('pause-joins').onclick=()=>action('/admin/joins',{accepting:false}).catch((error)=>byId('broadcast-error').textContent=error.message);byId('clear-avatars').onclick=()=>{if(confirm('Remove all viewer avatars from your world?'))action('/admin/clear').catch((error)=>byId('broadcast-error').textContent=error.message);};refresh();setInterval(refresh,1500);
byId('demo-toggle').onclick=()=>action('/admin/demo',{enabled:!latest.demo.enabled});byId('copy-world').onclick=()=>navigator.clipboard.writeText(questUrl).then(()=>{byId('copy-world').textContent='Copied!';setTimeout(()=>byId('copy-world').textContent='Copy Quest Link',1500)});byId('open-world').onclick=()=>window.open(questUrl,'_blank','noopener');
byId('sandbox-start').onclick=()=>action('/admin/sandbox/start');byId('sandbox-stop').onclick=()=>action('/admin/sandbox/stop');byId('sandbox-clear').onclick=()=>{if(confirm('Remove all Community Sandbox creations from the world?'))action('/admin/sandbox/clear');};byId('sandbox-mock').onclick=()=>action('/admin/sandbox/mock-request',{prompt:byId('sandbox-mock-prompt').value}).catch((error)=>byId('sandbox-config').textContent=error.message);
</script></main></body></html>`;
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
  sandbox.shutdown();
  for (const client of clients) client.close(1001, 'HoloHangout server stopping');
  webSockets.close();
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
