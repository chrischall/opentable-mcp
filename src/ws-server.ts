// OpenTableWsServer: the localhost WebSocket bridge the Chrome extension
// connects to. One active extension at a time (second connection is
// closed immediately). Tools call `fetch()` and the server relays the
// RPC to the extension's content script, which runs `window.fetch` in
// the page's MAIN world with cookies/TLS that Akamai accepts.
//
// Frame schema is documented in extension/README.md → "WS protocol".
// Timeouts:
//   connectTimeoutMs (default 15s) — how long fetch() will wait for the
//     extension to be `ready` before throwing `extension offline`.
//   requestTimeoutMs (default 30s) — per-request timeout once a request
//     has been sent.
//   PING_INTERVAL_MS (20s) — keep the MV3 service worker awake.
import { WebSocketServer, WebSocket } from 'ws';

export interface FetchInit {
  path: string;
  method: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResult {
  status: number;
  body: string;
  url: string;
}

interface PendingRequest {
  resolve: (v: FetchResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface ServerOptions {
  port?: number;
}

const PING_INTERVAL_MS = 20_000;

export class OpenTableWsServer {
  private readonly port: number;
  private wss: WebSocketServer | null = null;
  private active: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private pingTimer: NodeJS.Timeout | null = null;
  private connectTimeoutMs = 15_000;
  private requestTimeoutMs = 30_000;
  private readyResolvers: Array<() => void> = [];

  constructor(opts: ServerOptions = {}) {
    this.port = opts.port ?? 37149;
  }

  setConnectTimeoutMs(ms: number): void {
    this.connectTimeoutMs = ms;
  }

  setRequestTimeoutMs(ms: number): void {
    this.requestTimeoutMs = ms;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
      this.wss.on('listening', () => resolve());
      this.wss.on('error', reject);
      this.wss.on('connection', (ws) => this.handleConnection(ws));
    });
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Server closing'));
    }
    this.pending.clear();
    if (this.active) this.active.close();
    this.active = null;
    await new Promise<void>((r) => {
      if (!this.wss) return r();
      this.wss.close(() => r());
    });
    this.wss = null;
  }

  /**
   * Proxy a fetch through the extension. Throws if the extension is offline
   * beyond the connect timeout, or if the request itself times out.
   */
  async fetch(init: FetchInit): Promise<FetchResult> {
    await this.waitForConnection();
    if (!this.active) {
      throw new Error('opentable-mcp extension offline — install it and open an opentable.com tab');
    }
    const id = this.nextId++;
    return new Promise<FetchResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenTable request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.active!.send(JSON.stringify({ type: 'request', id, op: 'fetch', init }));
    });
  }

  private handleConnection(ws: WebSocket): void {
    if (this.active && this.active.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Another extension already connected');
      return;
    }
    this.active = ws;

    ws.on('message', (raw) => {
      let frame: { type?: string; [k: string]: unknown };
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type === 'hello') {
        // log + no-op; server already accepted the connection.
        return;
      }
      if (frame.type === 'ready') {
        // release any waiters
        const waiters = this.readyResolvers.splice(0);
        for (const r of waiters) r();
        return;
      }
      if (frame.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (frame.type === 'pong') {
        return;
      }
      if (frame.type === 'response' && typeof frame.id === 'number') {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.ok === true) {
          pending.resolve({
            status: Number(frame.status),
            body: String(frame.body ?? ''),
            url: String(frame.url ?? ''),
          });
        } else {
          pending.reject(new Error(String(frame.error ?? 'unknown extension error')));
        }
      }
    });

    ws.on('close', () => {
      if (this.active === ws) this.active = null;
      // Reject all pending
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Extension disconnected during request'));
      }
      this.pending.clear();
    });
  }

  private ping(): void {
    if (this.active && this.active.readyState === WebSocket.OPEN) {
      this.active.send(JSON.stringify({ type: 'ping' }));
    }
  }

  private waitForConnection(): Promise<void> {
    if (this.active && this.active.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.readyResolvers.indexOf(resolve);
        if (idx >= 0) this.readyResolvers.splice(idx, 1);
        reject(new Error('opentable-mcp extension offline — install it and open an opentable.com tab'));
      }, this.connectTimeoutMs);
      this.readyResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
