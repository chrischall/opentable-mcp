// Adapter that lets the @fetchproxy/server FetchproxyServer satisfy
// opentable-mcp's OpenTableTransport interface.
//
// FetchproxyServer is domain-agnostic — its FetchInit shape is
// `{ url, method, tabUrl, headers?, body? }`. opentable-mcp's tools and
// OpenTableClient have always used opentable-relative paths
// (`/dapi/...`, `/user/...`), so the adapter prepends
// `https://www.opentable.com` and pins `tabUrl` to opentable.com so the
// extension routes the fetch through the right tab.
//
// Aside from URL shape, the lifecycle and result types are identical to
// the legacy OpenTableWsServer.
import { FetchproxyServer, type FetchproxyServerOptions } from '@fetchproxy/server';
import type { FetchInit, FetchResult, OpenTableTransport } from './transport.js';

const OPENTABLE_ORIGIN = 'https://www.opentable.com';
const OPENTABLE_TAB_URL = 'https://www.opentable.com/';

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
    const options: FetchproxyServerOptions = {
      port: opts.port ?? 37149,
      server: opts.server ?? 'opentable-mcp',
      version: opts.version,
      domain: 'opentable.com',
    };
    this.inner = new FetchproxyServer(options);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const url = init.path.startsWith('http')
      ? init.path
      : `${OPENTABLE_ORIGIN}${init.path}`;
    return this.inner.fetch({
      url,
      method: init.method,
      tabUrl: OPENTABLE_TAB_URL,
      headers: init.headers,
      body: init.body,
    });
  }
}
