// Transport-agnostic interface for the bridge that relays OpenTable
// fetches through the user's real Chrome session.
//
// Implementations:
//   - src/transport-websocket.ts — our embedded extension + 127.0.0.1:37149
//     WebSocket. The default; what every release through v0.8.0 used.
//   - src/transport-mcp-chrome.ts — hangwin/mcp-chrome's HTTP MCP at
//     127.0.0.1:12306. Experimental; depends on mcp-chrome PR #348
//     (tabUrl support) landing in a published release.
//
// OpenTableClient (src/client.ts) accepts any OpenTableTransport. Error
// mapping (non-2xx, sign-in interstitial, 204 → null) lives on the
// client, not the transport — every implementation only has to round-
// trip the request and return a {status, body, url} triple.

export interface FetchInit {
  /** Path-and-query relative to https://www.opentable.com, e.g.
   *  `/user/dining-dashboard` or `/dapi/fe/gql?opname=...`. */
  path: string;
  method: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  /** Serialized request body. JSON callers stringify before calling.
   *  Omitted for GETs. */
  body?: string;
}

export interface FetchResult {
  status: number;
  /** Response body as a string. Empty string for 204. */
  body: string;
  /** Final URL after redirects. Used for sign-in-page detection. */
  url: string;
}

export interface OpenTableTransport {
  /** Bring the transport up. Idempotent. For WebSocket: start listening
   *  on the port. For mcp-chrome: open the HTTP MCP connection. */
  start(): Promise<void>;

  /** Tear the transport down. Idempotent. */
  close(): Promise<void>;

  /** Round-trip one request through the bridge. Resolves to a result
   *  triple even for non-2xx statuses — the client maps HTTP errors. */
  fetch(init: FetchInit): Promise<FetchResult>;
}
