// Adapter that lets the @fetchproxy/server FetchproxyServer satisfy
// opentable-mcp's OpenTableTransport interface.
//
// As of @fetchproxy/server 0.9.0, lazy-revive on Chrome MV3
// service-worker eviction (default 2000ms) and per-request timeouts
// (default 30000ms) are server defaults. We relied on the proactive
// keep-alive (`keepAliveIntervalMs: 25_000`) to hold the SW resident
// across human-paced session gaps — round-3 #67 evidence showed reactive
// lazy-revive alone wasn't enough. As of 0.10.0 that 25_000 cadence is
// the server default, so the explicit opt-in is gone (fetchproxy#72). The
// convenience `request()` method throws typed `FetchproxyBridgeDownError`
// / `FetchproxyTimeoutError` on failure (both subclasses of
// `FetchproxyProtocolError`).
import {
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyTransportAdapter,
} from '@chrischall/mcp-utils/fetchproxy';
import type { FetchInit, FetchResult, GraphqlQueryInit, OpenTableTransport } from './transport.js';

/** Logical handle for the RestaurantsAvailability op, matched against the
 *  declared `graphqlOps` entry below and referenced by `client.graphqlQuery`
 *  callers (currently just `opentable_find_slots`). */
export const AVAILABILITY_GRAPHQL_OP_NAME = 'availability';

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'opentable-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
}

export class FetchproxyTransport implements OpenTableTransport {
  // mcp-utils' createFetchproxyTransport owns the FetchproxyServer construction
  // + start/close lifecycle (the boilerplate ~12 sibling MCPs duplicate). It
  // forwards FetchproxyServerOpts verbatim, so the opentable contract is intact:
  // port 37149, serverName, version, and the opentable.com domain pin. We keep
  // the opentable-specific fetch() mapping (relative path → www subdomain →
  // {status,body,url}) here since it's domain-specific, not generic glue.
  private readonly inner: FetchproxyTransportAdapter;

  constructor(opts: FetchproxyTransportOptions) {
    this.inner = createFetchproxyTransport({
      port: opts.port ?? 37149,
      serverName: opts.server ?? 'opentable-mcp',
      version: opts.version,
      // 0.2.0+ takes a `domains` array. Subdomains of opentable.com
      // (e.g. www.opentable.com, mobile.opentable.com) match the
      // declared root automatically.
      domains: ['opentable.com'],
      // keepAliveIntervalMs is no longer set here: @fetchproxy/server 0.10.0
      // defaults it to 25_000 — the same cadence we used to hold the SW
      // resident across human-paced session gaps (fetchproxy#72).
      //
      // @fetchproxy/server 1.7.0+: the `graphql` capability routes
      // RestaurantsAvailability through the tab's own Apollo client
      // instead of the isolated-world fetch() path, which Akamai rejects
      // at the edge for this endpoint. The extension resolves the
      // declared `operationName` to the live DocumentNode it already
      // observed on the tab — no persisted-query hash needed here.
      capabilities: ['fetch', 'graphql'],
      graphqlOps: [
        { name: AVAILABILITY_GRAPHQL_OP_NAME, operationName: 'RestaurantsAvailability' },
      ],
    });
  }

  start(): Promise<void> {
    return this.inner.start();
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
    const response = await this.inner.server.request(init.method, init.path, {
      subdomain: 'www',
      headers: init.headers,
      body: init.body,
    });
    return { status: response.status, body: response.body, url: response.url };
  }

  async graphqlQuery(init: GraphqlQueryInit): Promise<unknown> {
    // No explicit tabUrl: opentable-mcp declares a single domain, so the
    // bridge auto-resolves a tab on it.
    return this.inner.server.graphqlQuery({ name: init.name, variables: init.variables });
  }
}
