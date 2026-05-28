// Adapter that lets the @fetchproxy/server FetchproxyServer satisfy
// opentable-mcp's OpenTableTransport interface.
//
// As of @fetchproxy/server 0.9.0, lazy-revive on Chrome MV3
// service-worker eviction (default 2000ms) and per-request timeouts
// (default 30000ms) are server defaults. We additionally opt into the
// 0.9.0 proactive keep-alive (`keepAliveIntervalMs: 25_000`) below to
// hold the SW resident across human-paced session gaps — round-3 #67
// evidence showed reactive lazy-revive alone wasn't enough. The
// convenience `request()` method throws typed `FetchproxyBridgeDownError`
// / `FetchproxyTimeoutError` on failure (both subclasses of
// `FetchproxyProtocolError`).
import { FetchproxyServer, type FetchproxyServerOpts } from '@fetchproxy/server';
import type { FetchInit, FetchResult, OpenTableTransport } from './transport.js';

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'opentable-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
}

export class FetchproxyTransport implements OpenTableTransport {
  private readonly inner: FetchproxyServer;

  constructor(opts: FetchproxyTransportOptions) {
    const options: FetchproxyServerOpts = {
      port: opts.port ?? 37149,
      serverName: opts.server ?? 'opentable-mcp',
      version: opts.version,
      // 0.2.0+ takes a `domains` array. Subdomains of opentable.com
      // (e.g. www.opentable.com, mobile.opentable.com) match the
      // declared root automatically.
      domains: ['opentable.com'],
      // fetchproxy#71 — keep SW resident across human-paced session gaps
      keepAliveIntervalMs: 25_000,
    };
    this.inner = new FetchproxyServer(options);
  }

  start(): Promise<void> {
    return this.inner.listen();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    // 0.8.0+: `request()` throws FetchproxyBridgeDownError on persistent
    // SW eviction (after the server's one-shot lazy-revive retry) and
    // FetchproxyTimeoutError on fetchTimeoutMs — both subclasses of
    // FetchproxyProtocolError so any caller catching the parent still
    // matches. The opentable contract (throw on protocol failures,
    // return on HTTP-level outcomes) is preserved.
    const response = await this.inner.request(init.method, init.path, {
      subdomain: 'www',
      headers: init.headers,
      body: init.body,
    });
    return { status: response.status, body: response.body, url: response.url };
  }
}
