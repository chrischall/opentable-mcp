# opentable-mcp v0.3 — Companion Chrome Extension

## Purpose

Unblock the OpenTable tool surface that Akamai denied us in v0.2. Replace the cycletls HTTP transport with a companion Chrome extension that forwards fetch requests through the user's real, authenticated opentable.com tab. Because the fetches run in that tab's page context — same TLS, same cookies, same behavioral telemetry — Akamai treats them as ordinary user traffic.

## Non-goals

- **Safari support.** Noted as "TBD if demand" in the README. Safari extensions are a separate build (Xcode + app wrapper + signing), ~10× the setup work, and nobody has asked for it yet.
- **Firefox support.** Same concern at smaller scale; MV3 extensions port with minor manifest tweaks, but the effort isn't free and there's no demand.
- **Cookie lifecycle.** The v0.2 `setup-auth.mjs` flow, `OPENTABLE_COOKIES` env var, `OPENTABLE_COOKIES_PATH`, and the cycletls dependency are all **removed**. The extension holds the session implicitly via the browser.
- **Authentication of the WS**. Localhost is trusted (user's own machine). Any shared-secret dance would add install friction for zero practical gain on a single-user dev tool.
- **A hosted / relay architecture.** Everything stays on 127.0.0.1.
- **Chrome Web Store distribution** for the initial release. The extension is side-loaded via `chrome://extensions` → "Load unpacked". A Web Store listing is a later exercise.

## Architecture

Three processes communicate over one WebSocket:

```
         ┌────────────────────────────┐
Claude → │ opentable-mcp (Node)       │
         │  - MCP tool handlers       │
         │  - parser modules          │
         │  - WS server on 127.0.0.1  │
         └─────────┬──────────────────┘
                   │ ws://127.0.0.1:37149
                   ▼
         ┌────────────────────────────┐
         │ Chrome extension           │
         │  - service worker (MV3)    │
         │  - content script          │
         │  - popup.html (status)     │
         └─────────┬──────────────────┘
                   │ chrome.runtime.sendMessage
                   ▼
         ┌────────────────────────────┐
         │ opentable.com tab (pinned) │
         │  - user is signed in       │
         │  - content script makes    │
         │    page-context fetch()    │
         └────────────────────────────┘
```

- **Runtime:** Node ≥ 18 for the MCP server (unchanged); Chrome 116+ for the MV3 extension.
- **Dependencies added:** `ws` for the server side; no runtime deps for the extension.
- **Dependencies removed:** `cycletls`.

## WebSocket protocol

JSON over a single bidirectional WS. Request/response correlated by monotonic `id`. Service worker owns the WS; content script is called via `chrome.runtime.sendMessage` for each pending request.

### Frames

Every frame is a JSON object with a `type`:

```ts
type Frame =
  | { type: 'hello'; protocol: 1; extensionVersion: string }     // extension → server on connect
  | { type: 'ready'; tabId: number; url: string }                // extension → server when content script attached
  | { type: 'request'; id: number; op: 'fetch'; init: FetchInit } // server → extension
  | { type: 'response'; id: number; ok: true; status: number; body: string; url: string }
                                                                  // extension → server
  | { type: 'response'; id: number; ok: false; error: string }   // extension → server
  | { type: 'ping' }                                              // either → either (keepalive)
  | { type: 'pong' }                                              // either → either

type FetchInit = {
  path: string;                   // `/r/gran-morsi-new-york?...`
  method: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;                  // already-encoded JSON or form-data
};
```

### Lifecycle

1. MCP server starts; WS server binds `127.0.0.1:37149`.
2. Extension service worker opens WS when first activated (on Chrome startup or when pinned tab loads).
3. Extension sends `hello` + `ready` (with the tab id).
4. MCP server accepts; if multiple extensions attempt to connect simultaneously, it keeps the first and closes the rest.
5. Tool call arrives → server sends `request` with monotonic `id` → awaits matching `response` with ≤ 30s timeout.
6. On WS disconnect (service worker slept, extension disabled, Chrome quit), server queues incoming tool calls for up to 10s waiting for reconnect; after that, returns an error to the tool caller.
7. `ping` / `pong` every 20s keeps MV3 service worker alive past its default 30s idle timer.

### Shape of a `fetch` op

The extension doesn't know about tools. It's a dumb relay. All parsing stays in the MCP server. For read operations (most tools): the server sends `{path, method: 'GET'}` and parses the returned HTML. For write operations (book, cancel, favorites CRUD): the server sends `{path, method: 'POST'|'DELETE', headers, body}` and parses the JSON response.

## Extension internals

### manifest.json (MV3)

```json
{
  "manifest_version": 3,
  "name": "opentable-mcp companion",
  "version": "0.3.0",
  "description": "Bridges the opentable-mcp server to your logged-in OpenTable tab.",
  "action": { "default_popup": "popup.html", "default_icon": "icon.png" },
  "permissions": ["tabs"],
  "host_permissions": ["https://www.opentable.com/*", "http://127.0.0.1:37149/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://www.opentable.com/*"], "js": ["content.js"], "run_at": "document_start" }
  ],
  "icons": { "128": "icon-128.png" }
}
```

### service worker (`background.js`)

Owns the WS connection and the request table. Responsible for:

- Connect to `ws://127.0.0.1:37149` on startup and on every service-worker awakening.
- Reconnect with exponential backoff (1s, 2s, 5s, 10s capped) on any disconnect.
- Find or create the opentable.com pinned tab. Strategy:
  1. `chrome.tabs.query({url: 'https://www.opentable.com/*'})` — prefer a `pinned: true` result if any; else the first result.
  2. Else `chrome.tabs.create({url: 'https://www.opentable.com/', pinned: true, active: false})`.
- On each `request` frame, `chrome.tabs.sendMessage(tabId, {id, init})` to the content script; resolve the response back to the WS.
- Keepalive via `ping`/`pong`; also uses `chrome.alarms` (MV3-native) on a 25s interval to stay alive.
- Emits status via `chrome.action.setBadgeText`: `"●"` green = connected + tab ready; yellow = connected but no opentable.com tab; red = WS disconnected.

### Content script (`content.js`)

Loaded at `document_start` on every opentable.com URL. Responsibilities:

- Listen for `chrome.runtime.onMessage` events from the service worker.
- On `{id, init}`:
  ```js
  const resp = await fetch(init.path, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    credentials: 'include',        // we want the session cookies
  });
  const body = await resp.text();
  sendResponse({ id, ok: true, status: resp.status, body, url: resp.url });
  ```
- No DOM parsing. No tool-specific logic.
- Reports its tab URL back on attach (e.g. `/user/dining-dashboard`) so the service worker can include it in `ready` frames.

### Popup (`popup.html` + `popup.js`)

Tiny status card. Shows:
- WS: connected / disconnected (with the server URL)
- Tab: `opentable.com` tab id + URL, or "not open"
- Signed in: yes/no (probed by content script on load looking for `authCke` cookie via `document.cookie`)
- "Open OpenTable" button if the pinned tab doesn't exist
- "Reconnect" button to force WS reconnect

No options page in v0.3 — port is hard-coded at `37149`. If a user wants to change it, they edit `background.js` for now. Configurable later.

## MCP server changes

### Files removed

- `src/client.ts` (cycletls-based) — replaced.
- `scripts/setup-auth.mjs` — no more manual cookie capture.
- `scripts/e2e-phase1.ts` — replaced by a new e2e.
- `.env.example` — empty; no env vars needed.
- `cycletls` dependency.

### Files added / updated

- `src/client.ts` — new `OpenTableClient` that wraps a WS client. API surface identical to v0.2 (`fetchHtml(path)`, `fetchJson(path, body?)`) so tool files don't change shape.
- `src/ws-server.ts` — bare `ws`-backed server that the client talks to. Owns the single connection, request-id table, ping/pong, and 30s per-request + 10s queued-on-disconnect timeouts.
- `src/index.ts` — registers all 10 tools (3 existing + 2 previously-unregistered + find_slots + 4 write tools).
- `src/tools/reservations.ts` — add `find_slots`, `book`, `cancel` (existing `list_reservations` stays).
- `src/tools/favorites.ts` — add `add_favorite`, `remove_favorite` (existing `list_favorites` stays).
- `src/parse-slots.ts` — new parser for the `RestaurantsAvailability` GraphQL response.
- `src/parse-book-response.ts` — new parser for the book-confirmation JSON.
- `src/tools/search.ts`, `src/tools/restaurants.ts` — re-registered from v0.2 (code already exists).
- `manifest.json` — lists all 10 tools (no more `user_config`; the extension is the auth medium).
- `extension/` — the Chrome extension source (see repo structure below).

### `OpenTableClient` new surface

```ts
class OpenTableClient {
  constructor(opts?: { port?: number; timeoutMs?: number })

  // Same shape tools already use:
  async fetchHtml(path: string): Promise<string>

  // New for write tools:
  async fetchJson<T>(path: string, init: {
    method: 'POST' | 'DELETE';
    headers?: Record<string, string>;
    body?: unknown;              // serialised to JSON internally
  }): Promise<T>

  async close(): Promise<void>   // shuts down the WS server
}
```

### Tool handlers

All 10 tools fit one of two patterns:

| Pattern | Tools | Uses |
|---|---|---|
| Fetch SSR HTML → parse `__INITIAL_STATE__` | `list_reservations`, `get_profile`, `list_favorites`, `search_restaurants`, `get_restaurant` | `client.fetchHtml` |
| POST to an OpenTable JSON endpoint → parse the reply | `find_slots`, `book`, `cancel`, `add_favorite`, `remove_favorite` | `client.fetchJson` |

## Tool specifications

The five read-only tools in pattern A are already implemented (v0.2 source). What's new:

### `opentable_find_slots`

**Flow:** POST the `RestaurantsAvailability` GraphQL query to `/dapi/fe/gql?opname=RestaurantsAvailability`. Return an array of `{reservation_token, date, time, party_size, type}` sorted by time ascending.

**Open question — discovery:** the GraphQL query body (operationName + query string + variables) needs to be captured once. Discovery method: during v0.3 implementation, have the content script log every outgoing `/dapi/fe/gql` XHR body. Load a restaurant page with a dateTime, observe the captured `RestaurantsAvailability` body, check it into the repo as a constant in `src/tools/reservations.ts`. The variables shape becomes the tool's input translation.

### `opentable_book`

**Flow:** Composite. `find_slots` to get a fresh token → POST `/dtp/eatery/reserve` (candidate) with `{slotToken, partySize, firstName, lastName, specialRequests}` → parse confirmation.

**Open question — discovery:** observe the Reserve-button flow in the content script; capture the POST URL, headers (notably `x-csrf-token` if any), and body shape. Check the final URL into source.

### `opentable_cancel`

**Flow:** POST `/dtp/eatery/reservation/{id}/cancel` (candidate) with `{securityToken}` from `list_reservations`. Parse the response for `{cancelled: true}`-equivalent signal.

### `opentable_add_favorite` / `opentable_remove_favorite`

**Flow:** POST / DELETE `/dtp/eatery/favorite/{restaurantId}` (candidate). Body might be empty or contain a CSRF token.

**Discovery pass:** all four write endpoints share the same approach. During implementation, the user manually performs each action (reserve, cancel, favorite, unfavorite) once in the pinned tab. The content script's XHR logger captures the request. We hard-code the stable parts (URL, method, headers minus CSRF) and the variable parts become tool inputs.

## Data flow

```
Claude tool call
  │
  ▼
MCP server tool handler
  │  build {path, method, body?}
  ▼
OpenTableClient.fetchHtml / fetchJson
  │  assign request id, push to WS, await response
  ▼
WS server → extension service worker
  │  chrome.tabs.sendMessage(tabId, {id, init})
  ▼
Content script on opentable.com tab
  │  fetch(path, {..., credentials: 'include'})
  ▼
opentable.com (real browser, real cookies, real Akamai state)
  │  HTML or JSON response
  ▼
content script → service worker → WS server → OpenTableClient
  │  text body
  ▼
parser (parse-dining-dashboard / parse-favorites / parse-slots / etc.)
  │  FormattedX
  ▼
tool handler → MCP content frame → Claude
```

All composite tools (`book` is the only one; uses `find_slots` internally) issue multiple `fetchJson` calls.

## Error handling

| Condition | Behaviour |
|---|---|
| MCP server starts, extension not connected | Tool calls queue 10s; if no connect, throw `"opentable-mcp extension offline — install it from the README and make sure Chrome is running with an opentable.com tab."` |
| Extension connected but no opentable.com tab | Service worker auto-opens a pinned one and waits for content script attach; retries the request once. If still failing, throw `"Unable to reach an opentable.com tab."` |
| Extension connected, tab open, user not signed in | Content script responds `{ok: true, status: 200, body: <sign-in page HTML>}`. Server's parser throws `SessionNotAuthenticatedError` with `"Sign in to OpenTable in your browser and try again."` |
| Per-request timeout (30s) | Throw `"OpenTable request timed out — page may be unresponsive; refresh the tab."` |
| Extension fetch returns non-2xx | Throw `"OpenTable API error: {status} {statusText} for {method} {path}"`. |
| Extension fetch throws (network) | Forward the error message; parser can't run. |
| WS disconnect mid-request | Server's pending-request table rejects all pending with `"Extension disconnected during request."` |
| Multiple Chrome profiles | Extension connects from the first profile whose Chrome is started; subsequent profiles are rejected (server keeps the first). |

## Testing

### Unit tests (Node)

- `src/client.ts`: mock a WS server in tests; exercise `fetchHtml`/`fetchJson`, id correlation, timeout, reconnect-retry, multi-pending requests in-flight.
- `src/ws-server.ts`: mock a WS client; exercise hello/ready, request, response, ping/pong, dropped connection.
- `src/parse-slots.ts`, `src/parse-book-response.ts`: synthetic fixtures (shape captured from real responses during the discovery pass), same pattern as v0.2 parsers.
- Tool tests: mock the client, assert tool handlers call the right paths with the right method/body and return the expected shape.
- **Coverage target:** ≥ 80% lines on `src/client.ts`, `src/ws-server.ts`, each parser, each tool.

### Integration (manual)

- Load-unpacked the extension in Chrome → Chrome auto-opens the pinned opentable.com tab → user signs in → MCP server run → Claude tool calls → verify shape.
- Smoke script `scripts/e2e-all.ts` exercises each of the 10 tools once with real account data; redacts PII in output the same way v0.2's smoke did.

## Build & packaging

### MCP server

- `npm run build` → `tsc --noEmit && esbuild src/index.ts --bundle --external:dotenv → dist/bundle.js`. `dotenv` could be removed but we'll keep it for MCPB convenience.
- `manifest.json` loses the `user_config.opentable_cookies` entry; adds no new user-facing config. No env required.

### Extension

- Side-loaded during development: `chrome://extensions` → "Developer mode" → "Load unpacked" → point at `extension/`.
- Packaging: the release workflow bundles the `extension/` directory into `opentable-mcp-extension-${VERSION}.zip` alongside the `.mcpb`. Users who want a stable install grab the zip and drag it to `chrome://extensions` or load-unpacked from the extracted directory.
- Chrome Web Store publication is a separate later task (needs developer account, $5 fee, review period).

## Repo structure

The extension lives as a subdirectory in `opentable-mcp` rather than a separate repo. Rationale: versioned together, single PR for "change the WS protocol on both sides", single CI, single README. Directory layout:

```
opentable-mcp/
├── src/                        # MCP server (unchanged layout, files updated)
├── tests/                      # existing vitest layout
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   ├── popup.js
│   └── icons/
│       ├── icon-16.png
│       ├── icon-48.png
│       └── icon-128.png
├── scripts/
│   └── e2e-all.ts              # replaces e2e-phase1.ts
├── docs/superpowers/
│   ├── specs/
│   │   └── 2026-04-20-companion-extension-design.md   ← this file
│   └── plans/
├── manifest.json               # MCPB manifest (simplified)
├── package.json
└── README.md                   # rewritten around the extension model
```

## Open questions deferred to implementation

1. **`RestaurantsAvailability` GraphQL body.** Capture during the content-script XHR discovery pass once. Check in verbatim.
2. **Reserve POST URL + body shape.** Same capture method. Reserve is the most involved flow (may include an intermediate "hold" step the web UI does).
3. **Cancel POST URL + body.** Capture from a live cancel flow on a real reservation. (This means we'll cancel one of the user's real reservations during discovery — acceptable since we re-book after, or use a canceled test reservation.)
4. **Favorite toggle endpoints.** Capture from the heart-button flow.
5. **CSRF token.** OpenTable's web app may require an `x-csrf-token` header on writes; content script reads from `window.__CSRF_TOKEN__` (confirmed present in hydrated pages during v0.2 probing).
6. **Exact port choice.** 37149 is arbitrary; confirm it doesn't collide with a common local-dev port. Keep it configurable via a constant if we hit a collision.
7. **Service-worker sleep and WS reconnect.** MV3 service workers sleep after ~30s of inactivity. Our ping/pong + `chrome.alarms` strategy *should* keep it alive indefinitely; verify during testing. If it doesn't, Native Messaging is the documented fallback in this repo's ADRs.
8. **Popup UI polish.** Initial version is barebones status text. Style later if desired.

Each of these is resolved inline during implementation and doesn't change scope.
