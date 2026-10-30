import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { ChatMessage } from './participant-manager.js';

const EVENTSUB_URL =
  'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';

export interface TwitchToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  login: string;
}

export interface TwitchConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface EventSubEnvelope {
  metadata: {
    message_id: string;
    message_type: string;
    subscription_type?: string;
  };
  payload: Record<string, unknown> & {
    session?: {
      id: string;
      keepalive_timeout_seconds: number | null;
      reconnect_url: string | null;
    };
    event?: {
      chatter_user_id?: string;
      chatter_user_name?: string;
      message?: { text?: string };
    };
  };
}

export interface TwitchStatus {
  connected: boolean;
  broadcasterLogin: string | null;
  error: string | null;
}

export class TwitchEventSub {
  private token: TwitchToken | null = null;
  private socket: WebSocket | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private validationTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private outboundTimer: NodeJS.Timeout | null = null;
  private readonly outboundMessages: string[] = [];
  private readonly seenMessageIds = new Set<string>();
  private stopped = false;
  private lastError: string | null = null;
  private keepaliveSeconds = 30;

  constructor(
    private readonly config: TwitchConfig,
    private readonly onChat: (message: ChatMessage) => void,
    private readonly onStatus: (status: TwitchStatus) => void,
    private readonly onToken?: (token: TwitchToken) => void,
  ) {}

  createAuthorizationUrl(state: string): string {
    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', 'user:read:chat user:write:chat');
    url.searchParams.set('state', state);
    return url.toString();
  }

  createState(): string {
    return randomBytes(24).toString('base64url');
  }

  async authorize(code: string): Promise<void> {
    this.clearTimers();
    this.socket?.close(1000, 'Twitch account reauthorized');
    this.socket = null;
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
    if (!response.ok) throw new Error(`Twitch token exchange failed (${response.status})`);
    const result = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const validation = await this.validate(result.access_token);
    this.token = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + result.expires_in * 1000,
      userId: validation.user_id,
      login: validation.login,
    };
    this.onToken?.({ ...this.token });
    this.stopped = false;
    this.lastError = null;
    this.scheduleRefresh();
    this.scheduleValidation();
    this.connect(EVENTSUB_URL, false);
  }

  async restore(token: TwitchToken): Promise<void> {
    this.token = { ...token };
    this.stopped = false;
    this.lastError = null;
    if (this.token.expiresAt <= Date.now() + 5 * 60_000) {
      await this.refresh();
    } else {
      const validation = await this.validate(token.accessToken);
      this.token.userId = validation.user_id;
      this.token.login = validation.login;
    }
    this.scheduleRefresh();
    this.scheduleValidation();
    this.connect(EVENTSUB_URL, false);
  }

  status(): TwitchStatus {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      broadcasterLogin: this.token?.login ?? null,
      error: this.lastError,
    };
  }

  disconnect(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close(1000, 'ChatIRL server stopped');
    this.socket = null;
    this.outboundMessages.length = 0;
  }

  sendChatMessage(message: string): void {
    const normalized = message.replace(/\s+/gu, ' ').trim().slice(0, 500);
    if (!normalized || this.token == null) return;
    if (this.outboundMessages.length >= 20) this.outboundMessages.shift();
    this.outboundMessages.push(normalized);
    this.drainOutboundMessages();
  }

  private connect(url: string, transferred: boolean, previous?: WebSocket): void {
    if (this.stopped || this.token == null) return;
    const socket = new WebSocket(url);
    if (!transferred) this.socket = socket;
    socket.on('message', (data) => {
      try {
        const envelope = JSON.parse(data.toString()) as EventSubEnvelope;
        this.handleEnvelope(socket, envelope, transferred, previous).catch(
          (error: unknown) => {
            this.reportError(error);
            socket.close(1011, 'Twitch EventSub handling failed');
          },
        );
      } catch (error) {
        this.reportError(error);
        socket.close(1007, 'Twitch sent invalid JSON');
      }
    });
    socket.on('error', (error) => this.reportError(error));
    socket.on('close', () => {
      if (socket !== this.socket || this.stopped) return;
      this.socket = null;
      this.onStatus({ connected: false, broadcasterLogin: this.token?.login ?? null, error: null });
      this.scheduleReconnect();
    });
  }

  private async handleEnvelope(
    socket: WebSocket,
    envelope: EventSubEnvelope,
    transferred: boolean,
    previous?: WebSocket,
  ): Promise<void> {
    if (this.seenMessageIds.has(envelope.metadata.message_id)) return;
    this.rememberMessage(envelope.metadata.message_id);
    switch (envelope.metadata.message_type) {
      case 'session_welcome': {
        const session = envelope.payload.session;
        if (session == null) throw new Error('Twitch welcome omitted its session');
        this.socket = socket;
        previous?.close(1000, 'Twitch reconnect transfer complete');
        this.keepaliveSeconds = session.keepalive_timeout_seconds ?? 30;
        this.armKeepalive(this.keepaliveSeconds);
        if (!transferred) await this.subscribe(session.id);
        this.lastError = null;
        this.onStatus({ connected: true, broadcasterLogin: this.token?.login ?? null, error: null });
        break;
      }
      case 'session_keepalive':
        this.armKeepalive(this.keepaliveSeconds);
        break;
      case 'notification': {
        const event = envelope.payload.event;
        const userId = event?.chatter_user_id;
        const displayName = event?.chatter_user_name;
        const text = event?.message?.text;
        if (userId && displayName && text) this.onChat({ userId, displayName, text });
        this.armKeepalive(this.keepaliveSeconds);
        break;
      }
      case 'session_reconnect': {
        const reconnectUrl = envelope.payload.session?.reconnect_url;
        if (reconnectUrl) this.connect(reconnectUrl, true, socket);
        break;
      }
      case 'revocation':
        this.lastError = 'Twitch revoked the chat subscription. Reauthorize ChatIRL.';
        this.onStatus({
          connected: false,
          broadcasterLogin: this.token?.login ?? null,
          error: this.lastError,
        });
        break;
    }
  }

  private async subscribe(sessionId: string): Promise<void> {
    const token = this.token;
    if (token == null) return;
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Client-Id': this.config.clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'channel.chat.message',
        version: '1',
        condition: {
          broadcaster_user_id: token.userId,
          user_id: token.userId,
        },
        transport: { method: 'websocket', session_id: sessionId },
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Twitch EventSub subscription failed (${response.status}): ${detail}`);
    }
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
    if (!response.ok) throw new Error('Twitch rejected the access token');
    const validation = (await response.json()) as {
      client_id: string;
      login: string;
      user_id: string;
      scopes: string[];
    };
    if (validation.client_id !== this.config.clientId) {
      throw new Error('Twitch token belongs to a different client ID');
    }
    for (const scope of ['user:read:chat', 'user:write:chat']) {
      if (!validation.scopes.includes(scope)) {
        throw new Error(`Twitch token is missing ${scope}; reauthorize ChatIRL.`);
      }
    }
    return validation;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
    if (this.token == null) return;
    const delay = Math.max(30_000, this.token.expiresAt - Date.now() - 5 * 60_000);
    this.refreshTimer = setTimeout(() => {
      this.refresh().catch((error) => {
        this.reportError(error);
        this.scheduleRefresh();
      });
    }, delay);
    this.refreshTimer.unref();
  }

  private scheduleValidation(): void {
    if (this.validationTimer != null) clearTimeout(this.validationTimer);
    this.validationTimer = setTimeout(() => {
      this.validateCurrentToken().catch((error) => this.reportError(error));
    }, 60 * 60_000);
    this.validationTimer.unref();
  }

  private async validateCurrentToken(): Promise<void> {
    if (this.token == null) return;
    try {
      try {
        await this.validate(this.token.accessToken);
      } catch {
        await this.refresh();
      }
    } finally {
      this.scheduleValidation();
    }
  }

  private async refresh(): Promise<void> {
    const token = this.token;
    if (token == null) return;
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
    if (!response.ok) throw new Error(`Twitch token refresh failed (${response.status})`);
    const result = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    await this.validate(result.access_token);
    token.accessToken = result.access_token;
    token.refreshToken = result.refresh_token;
    token.expiresAt = Date.now() + result.expires_in * 1000;
    this.onToken?.({ ...token });
    this.lastError = null;
    this.scheduleRefresh();
  }

  private armKeepalive(seconds: number): void {
    if (this.keepaliveTimer != null) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      this.socket?.terminate();
    }, (seconds + 10) * 1000);
    this.keepaliveTimer.unref();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(EVENTSUB_URL, false);
    }, 1500);
    this.reconnectTimer.unref();
  }

  private rememberMessage(messageId: string): void {
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > 1000) {
      const oldest = this.seenMessageIds.values().next().value as string | undefined;
      if (oldest != null) this.seenMessageIds.delete(oldest);
    }
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    this.onStatus({ connected: false, broadcasterLogin: this.token?.login ?? null, error: message });
  }

  private drainOutboundMessages(): void {
    if (this.outboundTimer != null || this.token == null) return;
    const message = this.outboundMessages.shift();
    if (message == null) return;
    void this.deliverChatMessage(message).finally(() => {
      this.outboundTimer = setTimeout(() => {
        this.outboundTimer = null;
        this.drainOutboundMessages();
      }, 1100);
      this.outboundTimer.unref();
    });
  }

  private async deliverChatMessage(message: string): Promise<void> {
    const token = this.token;
    if (token == null) return;
    const response = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Client-Id': this.config.clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        broadcaster_id: token.userId,
        sender_id: token.userId,
        message,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error(`Twitch welcome message failed (${response.status}): ${detail}`);
    }
  }

  private clearTimers(): void {
    for (const timer of [
      this.keepaliveTimer,
      this.refreshTimer,
      this.validationTimer,
      this.reconnectTimer,
      this.outboundTimer,
    ]) {
      if (timer != null) clearTimeout(timer);
    }
    this.keepaliveTimer = this.refreshTimer = this.validationTimer = this.reconnectTimer =
      this.outboundTimer = null;
  }
}
