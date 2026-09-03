// Adapter that lets the @fetchproxy/server FetchproxyServer satisfy
// opentable-mcp's OpenTableTransport interface.
//
// The floor is declared once, in package.json: `@fetchproxy/server` ^2.4.0.
// Every version note below records WHEN a behaviour arrived upstream, not a
// constraint this file still negotiates — all of them sit under the floor and
// are unconditionally satisfied. They are kept because the behaviours are
// implicit (server defaults we deliberately stopped setting), so without the
// provenance the absence of a setting reads as an oversight.
//
// Since @fetchproxy/server 0.9.0, lazy-revive on Chrome MV3
// service-worker eviction (default 2000ms) and per-request timeouts
// (default 30000ms) are server defaults. We relied on the proactive
// keep-alive (`keepAliveIntervalMs: 25_000`) to hold the SW resident
// across human-paced session gaps — round-3 #67 evidence showed reactive
// lazy-revive alone wasn't enough. Since 0.10.0 that 25_000 cadence is
// the server default, so the explicit opt-in is gone (fetchproxy#72). The
// convenience `request()` method throws typed `FetchproxyBridgeDownError`
// / `FetchproxyTimeoutError` on failure (both subclasses of
// `FetchproxyProtocolError`).
import {
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyTransportAdapter,
} from '@chrischall/mcp-utils/fetchproxy';
import { FetchproxyNoTabError } from '@fetchproxy/server';
import type { FetchInit, FetchResult, GraphqlQueryInit, OpenTableTransport } from './transport.js';
import { AVAILABILITY_GRAPHQL_OP_NAME } from './client.js';

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'opentable-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
}

/**
 * Relay tabs for write requests, tried in order.
 *
 * Every OpenTable write — the slot-lock and cancel GraphQL mutations AND the
 * REST `/dapi/booking/make-reservation` POST — is refused with an empty 403
 * unless it carries `x-csrf-token`. The extension injects that header from
 * the relay tab's `window.__CSRF_TOKEN__`, and only OpenTable's *app* pages
 * define it: restaurant profiles (`/r/…`), the booking flow (`/booking/…`),
 * and the account pages (`/user/…`). The homepage and search pages don't.
 *
 * fetchproxy's default relay is the FIRST tab on the host in Chrome's tab
 * order (`chrome.tabs.query`), so a user whose oldest OpenTable tab was the
 * homepage got every write 403'd — the 0.18.x symptom that 0.18.1 misread
 * as an isolated-world-vs-page distinction (live comparison 2026-09-02: the
 * same mutation passes from the isolated world through a CSRF-bearing tab,
 * and fails from the page's own world without the header). Naming the relay
 * tab is the fix; `/r/` comes first because `opentable_find_slots` already
 * needs a restaurant-profile tab, so the booking flow always has one.
 *
 * Matched by URL prefix (fetchproxy `viaTab`, 1.12.0+). When no tab matches
 * any prefix the request falls back to the default relay so wishlist writes
 * keep working for a user with, say, only a search tab open.
 */
export const WRITE_RELAY_TAB_PREFIXES: readonly string[] = [
  'https://www.opentable.com/r/',
  'https://www.opentable.com/booking/',
  'https://www.opentable.com/user/',
];

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
      // Since 0.2.0 this takes a `domains` array. Subdomains of opentable.com
      // (e.g. www.opentable.com, mobile.opentable.com) match the
      // declared root automatically.
      domains: ['opentable.com'],
      // keepAliveIntervalMs is no longer set here: @fetchproxy/server 0.10.0
      // defaults it to 25_000 — the same cadence we used to hold the SW
      // resident across human-paced session gaps (fetchproxy#72).
      //
      // Since @fetchproxy/server 1.7.0: the `graphql` capability routes
      // RestaurantsAvailability through the tab's own Apollo client
      // instead of the isolated-world fetch() path, which Akamai rejects
      // at the edge for this endpoint. The extension resolves the
      // declared `operationName` to the live DocumentNode it already
      // observed on the tab — no persisted-query hash needed here.
      //
      // `fetch_in_page` is deliberately NOT declared. 0.18.1 declared it on
      // the theory that OpenTable's edge 403s GraphQL mutations from the
      // isolated world; the 403 was really a relay tab without a CSRF token
      // (see WRITE_RELAY_TAB_PREFIXES). Routing a request through the page's
      // MAIN world hands page script the request, CSRF header included, so
      // it stays off unless something genuinely needs it.
      capabilities: ['fetch', 'graphql'],
      graphqlOps: [
        { name: AVAILABILITY_GRAPHQL_OP_NAME, operationName: 'RestaurantsAvailability' },
      ],
    });
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  /** Bridge liveness, delegated to the mcp-utils adapter (see transport.ts). */
  bridgeStatus(): unknown {
    return this.inner.status();
  }

  /** Probe round-trip, delegated to the mcp-utils adapter (see transport.ts). */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string,
  ): Promise<unknown> {
    return this.inner.runProbe(fetchFn, probePath);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    // Since 0.8.0: `request()` throws FetchproxyBridgeDownError on persistent
    // SW eviction (after the server's one-shot lazy-revive retry) and
    // FetchproxyTimeoutError on fetchTimeoutMs — both subclasses of
    // FetchproxyProtocolError so any caller catching the parent still
    // matches. The opentable contract (throw on protocol failures,
    // return on HTTP-level outcomes) is preserved.
    const base = {
      subdomain: 'www',
      headers: init.headers,
      body: init.body,
    };
    const issue = async (viaTab?: string): Promise<FetchResult> => {
      const response = await this.inner.server.request(init.method, init.path, {
        ...base,
        ...(viaTab === undefined ? {} : { viaTab }),
      });
      return { status: response.status, body: response.body, url: response.url };
    };

    // SSR GETs need no CSRF token; any signed-in tab will do.
    if (init.method === 'GET') return issue();

    // Writes: walk the CSRF-bearing app-page prefixes, then fall back.
    for (const prefix of WRITE_RELAY_TAB_PREFIXES) {
      try {
        return await issue(prefix);
      } catch (e) {
        if (!(e instanceof FetchproxyNoTabError)) throw e;
      }
    }
    return issue();
  }

  async graphqlQuery(init: GraphqlQueryInit): Promise<unknown> {
    // No explicit tabUrl: the extension walks the opentable.com tabs itself
    // until it finds one that has observed the operation.
    return this.inner.server.graphqlQuery({ name: init.name, variables: init.variables });
  }
}
