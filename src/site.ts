import './site.css';

interface DashboardState {
  csrfToken: string;
  worldUrl: string;
  streamer: { login: string; worldId: string };
  twitch: { connected: boolean; broadcasterLogin: string | null; clipsAuthorized: boolean; error: string | null };
  world: { connected: boolean; connectionCount: number };
  acceptingJoins: boolean;
  participants: Array<{
    userId: string;
    displayName: string;
    behavior: string;
    monsterName: string;
    supportedCommands: string[];
  }>;
  community: { realViewerCount: number; capacity: number };
  demo: { enabled: boolean; botCount: number };
  moments: {
    autoClipEnabled: boolean;
    state: string;
    message: string;
    recent: Array<{ id: string; url: string; title: string; createdAt: string }>;
  };
}

const root = document.getElementById('site-root');
const apiBase = (import.meta.env.VITE_HOLOHANGOUT_API_URL?.trim() || 'http://localhost:8788')
  .replace(/\/$/u, '');
let latest: DashboardState | null = null;
let refreshTimer: number | null = null;
const dashboardSessionKey = 'holohangout.dashboardSession';

export function renderSite(): void {
  if (root == null) return;
  if (window.location.pathname === '/dashboard') {
    captureDashboardSession();
    renderDashboardShell();
    void refreshDashboard();
  } else {
    renderLanding();
  }
}

function renderLanding(): void {
  if (root == null) return;
  root.innerHTML = `
    <div class="site-shell landing-shell">
      <nav class="nav"><a class="brand" href="/">Holo<span>Hangout</span></a><a class="nav-link" href="/dashboard">Streamer dashboard</a></nav>
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">TWITCH × MIXED REALITY</p>
          <h1>A New Dimension of <span>Shared Live Experiences.</span></h1>
          <p class="lede">Bringing Twitch viewers closer to their favorite VR streamers through a shared mixed-reality experience where they can socialize, interact, and play together.</p>
          <a class="primary-action" href="${escapeAttribute(`${apiBase}/auth/twitch`)}">Connect with Twitch</a>
          <p class="privacy-note">Secure Twitch authorization. Your Twitch credentials remain server-side.</p>
        </div>
        <div class="world-card" aria-label="HoloHangout experience preview">
          <div class="orb orb-one"></div><div class="orb orb-two"></div>
          <div class="mini-world"><div class="island"></div><div class="monster m1">●</div><div class="monster m2">●</div><div class="monster m3">●</div></div>
          <div class="live-chip"><i></i> COMMUNITY LIVE</div>
        </div>
      </section>
      <section class="steps" aria-label="How HoloHangout works">
        ${step('01', 'Connect your Twitch channel.', 'Authorize HoloHangout with the permissions needed for chat and clips.')}
        ${step('02', 'Enter your HoloHangout world.', 'Open your secure world link directly in Meta Quest Browser.')}
        ${step('03', 'Let viewers join with !join.', 'Every viewer becomes a named miniature monster in your real space.')}
        ${step('04', 'Hang out in mixed reality.', 'Grab avatars, play the blaster challenge, and create shared moments.')}
      </section>
    </div>`;
}

function renderDashboardShell(): void {
  if (root == null) return;
  root.innerHTML = `
    <div class="site-shell dashboard-shell">
      <nav class="nav"><a class="brand" href="/">Holo<span>Hangout</span></a><span class="nav-pill">Streamer control center</span></nav>
      <header class="dashboard-header"><div><p class="eyebrow">YOUR HOLOHANGOUT</p><h1 id="dashboard-title">Loading your world…</h1></div><a class="secondary-action" href="${escapeAttribute(`${apiBase}/auth/twitch`)}">Reconnect Twitch</a></header>
      <p id="dashboard-error" class="dashboard-error" role="alert"></p>
      <div id="dashboard-content" class="dashboard-grid" aria-live="polite"><section class="dashboard-card loading-card">Connecting securely…</section></div>
    </div>`;
}

async function refreshDashboard(): Promise<void> {
  try {
    const response = await fetch(`${apiBase}/api/session`, {
      credentials: 'include',
      cache: 'no-store',
      headers: dashboardHeaders(),
    });
    if (response.status === 401) {
      renderDisconnected();
      return;
    }
    if (!response.ok) throw new Error(await responseError(response));
    latest = await response.json() as DashboardState;
    renderDashboard(latest);
    if (refreshTimer == null) {
      refreshTimer = window.setInterval(() => void refreshDashboard(), 2500);
    }
  } catch (error) {
    showError(error);
  }
}

function renderDisconnected(): void {
  if (refreshTimer != null) window.clearInterval(refreshTimer);
  refreshTimer = null;
  const content = document.getElementById('dashboard-content');
  if (content == null) return;
  content.innerHTML = `<section class="dashboard-card full-card"><p class="eyebrow">TWITCH CONNECTION</p><h2>Connect your channel to continue</h2><p>Authorize HoloHangout to create your private streamer dashboard and world.</p><a class="primary-action" href="${escapeAttribute(`${apiBase}/auth/twitch`)}">Connect with Twitch</a></section>`;
}

function renderDashboard(state: DashboardState): void {
  const title = document.getElementById('dashboard-title');
  if (title != null) title.textContent = `${state.streamer.login}'s world`;
  const content = document.getElementById('dashboard-content');
  if (content == null) return;
  content.innerHTML = `
    <section class="dashboard-card"><div class="card-heading"><div><p class="eyebrow">TWITCH CONNECTION</p><h2>${escapeHtml(state.twitch.broadcasterLogin ?? state.streamer.login)}</h2></div>${statusChip(state.twitch.connected, state.twitch.connected ? 'Connected' : 'Needs attention')}</div><p class="card-copy">${escapeHtml(state.twitch.error ?? (state.twitch.clipsAuthorized ? 'Chat and Hangout Moments are authorized.' : 'Reconnect to authorize clips:edit for Hangout Moments.'))}</p></section>
    <section class="dashboard-card world-card-dashboard"><div class="card-heading"><div><p class="eyebrow">YOUR HOLOHANGOUT WORLD</p><h2>Quest world</h2></div>${statusChip(state.world.connected, state.world.connected ? 'Quest connected' : 'Waiting for Quest')}</div><p class="card-copy">Open this secured link in Meta Quest Browser, then select <strong>Enter AR</strong>.</p><div class="button-row"><button id="open-world" class="primary-button">Open World</button><button id="copy-world" class="secondary-button">Copy World URL</button></div><code class="world-id">World ${escapeHtml(state.streamer.worldId)}</code></section>
    <section class="dashboard-card"><div class="card-heading"><div><p class="eyebrow">COMMUNITY</p><h2>${state.community.realViewerCount}/${state.community.capacity} viewers</h2></div>${statusChip(state.acceptingJoins, state.acceptingJoins ? 'Joins open' : 'Joins paused')}</div><div class="button-row"><button id="toggle-joins" class="secondary-button">${state.acceptingJoins ? 'Pause joins' : 'Allow joins'}</button><button id="clear-viewers" class="danger-button">Clear avatars</button></div><div id="viewer-list" class="viewer-list"></div><details><summary>Viewer command reference</summary><p><code>!join · !blast · !leave</code></p><p>Monster-specific movement and animation commands appear when each viewer joins.</p></details></section>
    <section class="dashboard-card"><div class="card-heading"><div><p class="eyebrow">DEMO MODE</p><h2>${state.demo.enabled ? 'Active' : 'Off'}</h2></div>${statusChip(state.demo.enabled, state.demo.enabled ? `${state.demo.botCount} demo bots` : 'Real viewers only')}</div><p class="card-copy">Fill empty spots with clearly labeled demo monsters for rehearsals.</p><button id="toggle-demo" class="secondary-button">Turn Demo Mode ${state.demo.enabled ? 'off' : 'on'}</button></section>
    <section class="dashboard-card"><div class="card-heading"><div><p class="eyebrow">HANGOUT MOMENTS</p><h2>${escapeHtml(state.moments.message)}</h2></div>${statusChip(state.moments.state === 'ready' || state.moments.state === 'idle', state.moments.autoClipEnabled ? 'Auto-Clip ON' : 'Auto-Clip OFF')}</div><div class="button-row"><button id="toggle-auto-clip" class="secondary-button">Auto-Clip ${state.moments.autoClipEnabled ? 'Off' : 'On'}</button><button id="clip-now" class="primary-button" ${state.twitch.clipsAuthorized ? '' : 'disabled'}>Clip This Moment</button></div><div id="moments-list" class="moments-list"></div></section>
    <section class="dashboard-card full-card setup-card"><p class="eyebrow">STREAMING SETUP · OPTION A</p><h2>Quest Capture → USB → Receiver → OBS → Twitch</h2><ol><li>Install the existing HoloHangout Quest Capture APK.</li><li>Connect Quest to the computer by USB and configure the existing ADB reverse ports.</li><li>Start the local capture receiver and confirm <strong>Quest Capture Feed</strong> is active in OBS.</li><li>On Quest, tap <strong>Start Capture → Entire View</strong> and approve Android screen recording.</li><li>Start your Twitch broadcast from the existing local OBS control dashboard.</li></ol><p class="card-copy">The hosted Twitch backend does not replace the local receiver. USB, the receiver, and OBS continue running on the streamer's computer. MQDH remains the fallback.</p></section>`;
  bindDashboardActions(state);
  renderViewers(state);
  renderMoments(state);
}

function bindDashboardActions(state: DashboardState): void {
  byId('open-world').onclick = () => window.open(state.worldUrl, '_blank', 'noopener');
  byId('copy-world').onclick = () => void navigator.clipboard.writeText(state.worldUrl)
    .then(() => setButtonText('copy-world', 'Copied!'))
    .catch(showError);
  byId('toggle-joins').onclick = () => void action('/api/admin/joins', { accepting: !state.acceptingJoins });
  byId('clear-viewers').onclick = () => {
    if (window.confirm('Remove every active viewer avatar from this world?')) void action('/api/admin/clear');
  };
  byId('toggle-demo').onclick = () => void action('/api/admin/demo', { enabled: !state.demo.enabled });
  byId('toggle-auto-clip').onclick = () => void action('/api/admin/moments/auto', { enabled: !state.moments.autoClipEnabled });
  byId('clip-now').onclick = () => void action('/api/admin/moments/clip');
}

function renderViewers(state: DashboardState): void {
  const list = document.getElementById('viewer-list');
  if (list == null) return;
  if (state.participants.length === 0) {
    list.innerHTML = '<p class="empty-state">No real viewers have joined yet.</p>';
    return;
  }
  list.replaceChildren(...state.participants.map((viewer) => {
    const row = document.createElement('div');
    row.className = 'viewer-row';
    const identity = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = viewer.displayName;
    const detail = document.createElement('small');
    detail.textContent = `${viewer.monsterName} · ${viewer.behavior}`;
    identity.append(name, detail);
    const remove = document.createElement('button');
    remove.className = 'text-button';
    remove.textContent = 'Remove';
    remove.onclick = () => void action('/api/admin/participants/remove', { userId: viewer.userId });
    row.append(identity, remove);
    return row;
  }));
}

function renderMoments(state: DashboardState): void {
  const list = document.getElementById('moments-list');
  if (list == null) return;
  if (state.moments.recent.length === 0) {
    list.innerHTML = '<p class="empty-state">No verified clips yet.</p>';
    return;
  }
  list.replaceChildren(...state.moments.recent.map((clip) => {
    const link = document.createElement('a');
    link.className = 'moment-link';
    link.href = clip.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = `${clip.title} · ${new Date(clip.createdAt).toLocaleString()}`;
    return link;
  }));
}

async function action(path: string, body: Record<string, unknown> = {}): Promise<void> {
  if (latest == null) return;
  try {
    const response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...dashboardHeaders(),
        'Content-Type': 'application/json',
        'X-HoloHangout-CSRF': latest.csrfToken,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await responseError(response));
    await refreshDashboard();
  } catch (error) {
    showError(error);
  }
}

function statusChip(ok: boolean, label: string): string {
  return `<span class="status-chip ${ok ? 'ok' : 'waiting'}"><i></i>${escapeHtml(label)}</span>`;
}

function step(number: string, title: string, copy: string): string {
  return `<article class="step"><span>${number}</span><h2>${title}</h2><p>${copy}</p></article>`;
}

function byId(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

function setButtonText(id: string, text: string): void {
  const button = byId(id);
  const original = button.textContent;
  button.textContent = text;
  window.setTimeout(() => { button.textContent = original; }, 1500);
}

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? `Request failed (${response.status}).`;
}

function showError(error: unknown): void {
  const target = document.getElementById('dashboard-error');
  if (target != null) target.textContent = error instanceof Error ? error.message : String(error);
}

function captureDashboardSession(): void {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const session = hash.get('session');
  if (session != null) {
    window.localStorage.setItem(dashboardSessionKey, session);
    window.history.replaceState(null, '', '/dashboard');
  }
}

function dashboardHeaders(): Record<string, string> {
  const session = window.localStorage.getItem(dashboardSessionKey);
  return session == null ? {} : { Authorization: `Bearer ${session}` };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
