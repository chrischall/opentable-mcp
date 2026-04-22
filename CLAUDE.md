# CLAUDE.md — opentable-mcp

Guidance for Claude working in this repo.

## TL;DR

v0.3.0-alpha: OpenTable MCP server with 10 tools (read + write), fronted by a
localhost WebSocket bridge to a companion Chrome extension running in the
user's signed-in tab. Akamai never sees us — every request is a real
browser fetch.

## Commands

- `npm test` — vitest, all mocked, no network. Must stay green.
- `npm run build` — tsc typecheck + esbuild bundle → `dist/bundle.js`.
- `npx tsc --noEmit` — typecheck only.
- `node dist/bundle.js` — launch the MCP server over stdio (also starts the WS listener).
- `npx tsx scripts/probe-find-slots.ts` — live GET round-trip via the extension.
- `npx tsx scripts/probe-favorites-toggle.ts` — live add + remove favorite.
- `npx tsx scripts/probe-book-cancel.ts` — **books and immediately cancels a real reservation.** Pick a restaurant that won't mind a 3-second booking.
- `npx tsx scripts/probe-list-res.ts` — dump upcoming reservations; useful after a probe to check for dangling ones.
- `npx tsx scripts/serve-only.ts` — raw WS listener that logs every extension frame. Debugging only.

All `probe-*.ts` scripts require the extension loaded at `chrome://extensions`
and a signed-in opentable tab.

## Architecture

```
┌────────────────┐  stdio   ┌──────────────────┐   WS   ┌────────────┐    fetch()    ┌─────────────┐
│ MCP client     │◀────────▶│  dist/bundle.js  │◀──────▶│ extension  │◀────────────▶│ opentable   │
│ (Claude, etc.) │          │  (OpenTable MCP) │ :37149 │ (SW + CS)  │   (real TLS, │ .com (tab)  │
└────────────────┘          └──────────────────┘        └────────────┘   cookies)    └─────────────┘
```

- **`src/ws-server.ts`** — `OpenTableWsServer`: 127.0.0.1:37149 listener. Accepts one extension, routes `fetch` RPCs, 20s ping/pong, 15s connect timeout, 30s request timeout.
- **`src/client.ts`** — `OpenTableClient`: thin wrapper around the WS server. `fetchHtml(path)` for GETs that return HTML, `fetchJson(path, init)` for JSON POSTs/DELETEs. Maps non-2xx, empty-body (204), and sign-in-page responses into typed errors.
- **`src/tools/*.ts`** — one file per concern. Each exports `registerXxxTools(server, client)`. See "Tool surface" below.
- **`src/parse-*.ts`** — pure HTML/JSON parsers. Fully unit-tested.
- **`extension/`** — MV3 companion extension:
  - `manifest.json` — MV3, two `content_scripts` entries (isolated + MAIN world), `scripting` permission for self-heal.
  - `background.js` — service worker, owns the WS, routes fetches to the tab via `chrome.tabs.sendMessage`, self-heals dead content scripts via `chrome.scripting.executeScript`.
  - `content.js` — isolated-world fetch relay. Adds CSRF from `document.documentElement.dataset.otMcpCsrf`, calls `fetch(url, { credentials: 'include' })`, returns `{ok, status, body, url}`.
  - `capture-logger.js` — MAIN-world XHR/fetch logger. Populates `window.__otMcpCaptures` for endpoint discovery, syncs `window.__CSRF_TOKEN__` to the DOM dataset so the isolated content script can read it.
  - `popup.html` / `popup.js` — three-dot status (WS / tab / auth) + Reconnect + Open OpenTable buttons.
- **`tests/`** — 1:1 mirror of `src/`. `tests/helpers.ts` provides an in-memory MCP harness (stdio transports on a PassThrough pair) for tool tests.

## Tool surface

| Tool | File | Endpoint(s) | Kind |
| --- | --- | --- | --- |
| `opentable_list_reservations` | `tools/reservations.ts` | GET `/user/dining-dashboard` SSR | read |
| `opentable_get_profile` | `tools/user.ts` | GET `/user/dining-dashboard` SSR | read |
| `opentable_list_favorites` | `tools/favorites.ts` | GET `/user/favorites` SSR | read |
| `opentable_search_restaurants` | `tools/search.ts` | POST `/dapi/fe/gql?opname=Autocomplete` | read |
| `opentable_get_restaurant` | `tools/restaurants.ts` | GET `/r/{slug}` SSR | read |
| `opentable_find_slots` | `tools/reservations.ts` | POST `/dapi/fe/gql?opname=RestaurantsAvailability` | read |
| `opentable_book_preview` | `tools/reservations.ts` | GET `/booking/details` SSR + POST `BookDetailsStandardSlotLock` | read |
| `opentable_book` | `tools/reservations.ts` | (token path) POST `/dapi/booking/make-reservation`; (no-token path) GET `/booking/details` SSR + POST `BookDetailsStandardSlotLock` → POST `/dapi/booking/make-reservation` | write |
| `opentable_cancel` | `tools/reservations.ts` | POST `/dapi/fe/gql?opname=CancelReservation` | write |
| `opentable_add_favorite` | `tools/favorites.ts` | POST `/dapi/wishlist/add` | write |
| `opentable_remove_favorite` | `tools/favorites.ts` | POST `/dapi/wishlist/remove` | write |

## Conventions

- All tools are `opentable_*`-prefixed.
- Tool return shape: `{ content: [{ type: 'text', text: JSON.stringify(..., null, 2) }] }`.
- Readonly tools set `annotations: { readOnlyHint: true }`.
- Prefer JSON bodies. The write tools hit OpenTable's internal JSON/GraphQL endpoints; don't use `URLSearchParams` unless an endpoint explicitly requires form-encoding.
- Write a failing test before implementation (TDD). Tool tests live in `tests/tools/<name>.test.ts` and mock `OpenTableClient.fetchJson` / `fetchHtml`.
- Prefer Apollo persisted queries (just the `sha256Hash`, no GraphQL body). Hashes are pinned at the top of the tool file — if OpenTable re-deploys, the server returns `PersistedQueryNotFound` and the hashes need re-capture via the extension's XHR logger.

## Hot spots / gotchas

- **`/r/<numeric-id>` 404s.** OpenTable's restaurant URLs use slugs (`/r/state-of-confusion-charlotte`), not numeric IDs. `opentable_book` therefore requires `dining_area_id` as an explicit arg — call `opentable_get_restaurant` with a slug first to read `diningAreas[]`.
- **Content scripts don't survive extension reload.** Existing opentable tabs lose `content.js` + `capture-logger.js` when the extension reloads. The background SW re-injects them automatically (onInstalled/onStartup + fallback on `sendMessage` failure). If a user hits "Could not establish connection" errors, reloading the extension once should fix it permanently.
- **MV3 service worker sleeps.** Idle SWs get killed after ~30s. We hold a 20s ping to the server and a 25s `chrome.alarms` tick. Cold wake can delay the first request by up to ~5s.
- **CSRF tokens live on `window.__CSRF_TOKEN__`** (MAIN world) but `content.js` runs in an isolated world. `capture-logger.js` syncs the token to `document.documentElement.dataset.otMcpCsrf` every 2s so `content.js` can include it in headers for write endpoints.
- **Persisted-query cache lag on `/user/favorites`.** After `add_favorite` returns 204, the SSR dashboard may not reflect the new entry for ~10s. Document this in the tool description, don't fight the cache.
- **Sign-in detection.** `OpenTableClient.throwIfSignInPage` checks for `/authenticate/` in the response URL or sign-in markers in a short response body. When it throws, the user must sign into opentable.com in the bridged Chrome tab.
- **CC-required slots route through preview.** The slot-lock response doesn't carry the CC-required flag or cancellation policy — those live in the `/booking/details` SSR page's `__INITIAL_STATE__` (`timeSlot.creditCardRequired`, `messages.cancellationPolicyMessage`, `wallet.savedCards`). `opentable_book_preview` fetches that page + slot-locks, and mints a `booking_token` that `opentable_book` consumes. `booking_token` is opaque, stateless base64-JSON — no server-side cache — with a tamper check (restaurant/date/time/party/dining-area must match the caller's own args). OpenTable's ~90 s slot-lock TTL is the only expiry; a stale token surfaces as `SLOT_LOCK_EXPIRED` which `opentable_book` maps to an actionable error.

## Live probing workflow

1. `npm run build` — keep `dist/bundle.js` fresh.
2. `lsof -ti :37149 | xargs -r kill` — clear any orphan MCP server from a prior crashed probe.
3. `npx tsx scripts/probe-<x>.ts` — the probe spawns its own `dist/bundle.js` over stdio. The extension reconnects within ~2s (tight 200-5000ms backoff) and announces `ready` once it finds an opentable tab.
4. If the first call fails with "extension offline", the extension is probably sleeping — reopen the popup or reload the extension once.

## What to *not* do

- Don't add new transport-layer hacks (cycletls, impersonate-curl, Playwright). v0.2 tried those; Akamai wins. The extension bridge is the whole design.
- Don't paste cookies or env-configure auth. Auth lives in the user's browser now.
- Don't register tools that can't be tested against a mock `OpenTableClient`. All tool logic should be behind `fetchJson` / `fetchHtml` so tests can drive it without a real WS.
- Don't bump the persisted-query hashes speculatively. Only re-capture when a live request fails with `PersistedQueryNotFound`.
