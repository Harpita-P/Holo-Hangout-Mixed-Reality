import {
  isClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '../shared/protocol.js';

export type SocketStatus = 'connecting' | 'connected' | 'disconnected';

export class ChatIRLSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private retryCount = 0;
  private closed = false;

  constructor(
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onStatus: (status: SocketStatus) => void,
  ) {
    this.connect();
  }

  send(message: ClientMessage): void {
    if (!isClientMessage(message) || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer != null) window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'ChatIRL client closed');
    this.socket = null;
  }

  private connect(): void {
    if (this.closed) return;
    this.onStatus('connecting');
    const configured =
      import.meta.env.VITE_HOLOHANGOUT_WS_URL?.trim() ||
      import.meta.env.VITE_CHATIRL_WS_URL?.trim();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(configured || `${protocol}//${window.location.host}/chatirl`);
    const worldMatch = window.location.pathname.match(/^\/world\/([^/]+)\/?$/u);
    const credential = new URLSearchParams(window.location.hash.slice(1)).get('credential');
    if (worldMatch != null && credential != null) {
      url.searchParams.set('world', decodeURIComponent(worldMatch[1] ?? ''));
      url.searchParams.set('credential', credential);
    }
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retryCount = 0;
      this.onStatus('connected');
      this.send({ type: 'client.ready' });
    });
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (typeof message === 'object' && message != null && 'type' in message) {
          this.onMessage(message);
        }
      } catch {
        // Ignore malformed server payloads; a snapshot will restore state.
      }
    });
    socket.addEventListener('close', () => this.scheduleReconnect(socket));
    socket.addEventListener('error', () => socket.close());
  }

  private scheduleReconnect(socket: WebSocket): void {
    if (socket !== this.socket || this.closed) return;
    this.onStatus('disconnected');
    const delay = Math.min(5000, 400 * 2 ** this.retryCount);
    this.retryCount += 1;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }
}
