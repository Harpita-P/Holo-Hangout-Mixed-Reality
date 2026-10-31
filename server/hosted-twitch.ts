import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChatMessage } from './participant-manager.js';
import type { TwitchStatus, TwitchToken } from './twitch-eventsub.js';

export interface HostedTwitchConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  eventSubCallbackUrl: string;
  eventSubSecret: string;
}

export interface TwitchWebhookEvent {
  broadcasterUserId: string;
  message: ChatMessage;
}

export class HostedTwitchAccount {
  private token: TwitchToken | null = null;
  private readonly scopes = new Set<string>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private lastError: string | null = null;

  constructor(
    private readonly config: HostedTwitchConfig,
    private readonly onToken: (token: TwitchToken) => void | Promise<void>,
    private readonly onStatus: (status: TwitchStatus) => void,
  ) {}

  createAuthorizationUrl(state: string): string {
    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', 'user:read:chat user:write:chat clips:edit');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async authorize(code: string): Promise<TwitchToken> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.config.redirectUri,
    });
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error(`Twitch token exchange failed (${response.status}).`);
    const result = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const validation = await this.validate(result.access_token);
    this.setScopes(validation.scopes);
    this.token = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + result.expires_in * 1000,
      userId: validation.user_id,
      login: validation.login,
    };
    await this.onToken({ ...this.token });
    await this.finishConnection();
    return { ...this.token };
  }

  async restore(token: TwitchToken): Promise<void> {
    this.token = { ...token };
    try {
      if (token.expiresAt <= Date.now() + 60_000) {
        await this.refresh();
      } else {
        const validation = await this.validate(token.accessToken);
        this.setScopes(validation.scopes);
        this.token.userId = validation.user_id;
        this.token.login = validation.login;
      }
      await this.finishConnection();
    } catch (error) {
      this.connected = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.onStatus(this.status());
      throw error;
    }
  }

  status(): TwitchStatus {
    return {
      connected: this.connected,
      broadcasterLogin: this.token?.login ?? null,
      clipsAuthorized: this.clipsAuthorized(),
      error: this.lastError,
    };
  }

  clipsAuthorized(): boolean {
    return this.scopes.has('clips:edit');
  }

  async isBroadcasterLive(): Promise<boolean> {
    const token = await this.currentToken();
    const url = new URL('https://api.twitch.tv/helix/streams');
    url.searchParams.set('user_id', token.userId);
    const response = await fetch(url, { headers: this.userHeaders(token) });
    if (!response.ok) throw new Error(`Twitch live-status check failed (${response.status}).`);
    const result = await response.json() as { data?: unknown[] };
    return (result.data?.length ?? 0) > 0;
  }

  async createClip(title: string, duration: number): Promise<{ id: string }> {
    if (!this.clipsAuthorized()) throw new Error('Reconnect Twitch to grant clips:edit.');
    const token = await this.currentToken();
    const url = new URL('https://api.twitch.tv/helix/clips');
    url.searchParams.set('broadcaster_id', token.userId);
    url.searchParams.set('title', title.slice(0, 100));
    url.searchParams.set('duration', String(Math.max(5, Math.min(60, duration))));
    const response = await fetch(url, { method: 'POST', headers: this.userHeaders(token) });
    if (!response.ok) throw new Error(`Twitch clip creation failed (${response.status}).`);
    const result = await response.json() as { data?: Array<{ id?: string }> };
    const id = result.data?.[0]?.id;
    if (!id) throw new Error('Twitch accepted the clip request without returning a clip ID.');
    return { id };
  }

  async getClip(id: string): Promise<{ id: string; url: string; title: string; createdAt: string } | null> {
    const token = await this.currentToken();
    const url = new URL('https://api.twitch.tv/helix/clips');
    url.searchParams.set('id', id);
    const response = await fetch(url, { headers: this.userHeaders(token) });
    if (!response.ok) throw new Error(`Twitch clip verification failed (${response.status}).`);
    const result = await response.json() as {
      data?: Array<{ id?: string; url?: string; title?: string; created_at?: string }>;
    };
    const clip = result.data?.[0];
    if (!clip?.id || !clip.url) return null;
    return {
      id: clip.id,
      url: clip.url,
      title: clip.title ?? 'HoloHangout Moment',
      createdAt: clip.created_at ?? new Date().toISOString(),
    };
  }

  async sendChatMessage(message: string): Promise<void> {
    const normalized = message.replace(/\s+/gu, ' ').trim().slice(0, 500);
    if (!normalized) return;
    const token = await this.currentToken();
    const response = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: { ...this.userHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        broadcaster_id: token.userId,
        sender_id: token.userId,
        message: normalized,
      }),
    });
    if (!response.ok) throw new Error(`Twitch chat reply failed (${response.status}).`);
  }

  disconnect(): void {
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.connected = false;
  }

  private async finishConnection(): Promise<void> {
    await this.ensureChatSubscription();
    this.connected = true;
    this.lastError = null;
    this.scheduleRefresh();
    this.onStatus(this.status());
  }

  private async ensureChatSubscription(): Promise<void> {
    const token = this.token;
    if (token == null) throw new Error('Twitch authorization is unavailable.');
    const appToken = await this.appAccessToken();
    const headers = { Authorization: `Bearer ${appToken}`, 'Client-Id': this.config.clientId };
    const listUrl = new URL('https://api.twitch.tv/helix/eventsub/subscriptions');
    listUrl.searchParams.set('type', 'channel.chat.message');
    listUrl.searchParams.set('status', 'enabled');
    const existingResponse = await fetch(listUrl, { headers });
    if (!existingResponse.ok) {
      throw new Error(`Twitch EventSub lookup failed (${existingResponse.status}).`);
    }
    const existing = await existingResponse.json() as {
      data?: Array<{
        condition?: { broadcaster_user_id?: string; user_id?: string };
        transport?: { method?: string; callback?: string };
      }>;
    };
    const found = existing.data?.some((subscription) =>
      subscription.condition?.broadcaster_user_id === token.userId &&
      subscription.condition?.user_id === token.userId &&
      subscription.transport?.method === 'webhook' &&
      subscription.transport?.callback === this.config.eventSubCallbackUrl
    );
    if (found) return;
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: token.userId, user_id: token.userId },
        transport: {
          method: 'webhook',
          callback: this.config.eventSubCallbackUrl,
          secret: this.config.eventSubSecret,
        },
      }),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`Twitch EventSub subscription failed (${response.status}).`);
    }
  }

  private async appAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'client_credentials',
    });
    const response = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body });
    if (!response.ok) throw new Error(`Twitch app authorization failed (${response.status}).`);
    const result = await response.json() as { access_token?: string };
    if (!result.access_token) throw new Error('Twitch app authorization returned no token.');
    return result.access_token;
  }

  private async validate(accessToken: string): Promise<{
    client_id: string;
    login: string;
    user_id: string;
    scopes: string[];
  }> {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${accessToken}` },
    });
    if (!response.ok) throw new Error('Twitch rejected the access token.');
    const validation = await response.json() as {
      client_id: string;
      login: string;
      user_id: string;
      scopes: string[];
    };
    if (validation.client_id !== this.config.clientId) {
      throw new Error('Twitch token belongs to a different client ID.');
    }
    for (const scope of ['user:read:chat', 'user:write:chat']) {
      if (!validation.scopes.includes(scope)) {
        throw new Error(`Twitch token is missing ${scope}; reconnect Twitch.`);
      }
    }
    return validation;
  }

  private async refresh(): Promise<void> {
    const token = this.token;
    if (token == null) throw new Error('Twitch authorization is unavailable.');
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
    });
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error(`Twitch token refresh failed (${response.status}).`);
    const result = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const validation = await this.validate(result.access_token);
    this.setScopes(validation.scopes);
    token.accessToken = result.access_token;
    token.refreshToken = result.refresh_token;
    token.expiresAt = Date.now() + result.expires_in * 1000;
    token.userId = validation.user_id;
    token.login = validation.login;
    await this.onToken({ ...token });
    this.connected = true;
    this.lastError = null;
    this.scheduleRefresh();
    this.onStatus(this.status());
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
    if (this.token == null) return;
    const delay = Math.max(30_000, this.token.expiresAt - Date.now() - 5 * 60_000);
    this.refreshTimer = setTimeout(() => {
      void this.refresh().catch((error: unknown) => {
        this.connected = false;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.onStatus(this.status());
      });
    }, delay);
    this.refreshTimer.unref();
  }

  private async currentToken(): Promise<TwitchToken> {
    if (this.token == null) throw new Error('Connect Twitch before using this action.');
    if (this.token.expiresAt <= Date.now() + 30_000) await this.refresh();
    if (this.token == null) throw new Error('Twitch authorization is unavailable.');
    return this.token;
  }

  private userHeaders(token: TwitchToken): Record<string, string> {
    return { Authorization: `Bearer ${token.accessToken}`, 'Client-Id': this.config.clientId };
  }

  private setScopes(scopes: string[]): void {
    this.scopes.clear();
    for (const scope of scopes) this.scopes.add(scope);
  }
}

export function verifyTwitchWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  secret: string,
  now = Date.now(),
): boolean {
  const messageId = singleHeader(headers['twitch-eventsub-message-id']);
  const timestamp = singleHeader(headers['twitch-eventsub-message-timestamp']);
  const supplied = singleHeader(headers['twitch-eventsub-message-signature']);
  if (!messageId || !timestamp || !supplied) return false;
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > 10 * 60_000) return false;
  const expected = `sha256=${createHmac('sha256', secret)
    .update(messageId + timestamp + rawBody)
    .digest('hex')}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
