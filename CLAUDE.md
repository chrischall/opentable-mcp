# CLAUDE.md — opentable-mcp

Guidance for Claude working in this repo.

## TL;DR

v0.9.0: OpenTable MCP server with 11 tools (read + write), fronted by a
localhost WebSocket bridge to a companion Chrome extension running in the
user's signed-in tab. Akamai never sees us — every request is a real
browser fetch.

## Commands

- `npm test` — vitest, all mocked, no network. Must stay green.
- `npm run build` — `tsc --noEmit` typecheck + esbuild bundle → `dist/bundle.js`.
- `npx tsc --noEmit` — typecheck only (also runs as part of `npm run build`).
- `node dist/bundle.js` — launch the MCP server over stdio (also starts the WS listener).
- `npx tsx scripts/probe-find-slots.ts` — live GET round-trip via the extension.
- `npx tsx scripts/probe-favorites-toggle.ts` — live add + remove favorite.
- `npx tsx scripts/probe-book-cancel.ts` — **books and immediately cancels a real reservation.** Pick a restaurant that won't mind a 3-second booking.
- `npx tsx scripts/probe-book-cc-cancel.ts` — same as above but for a CC-required slot (exercises the preview → book flow).
- `npx tsx scripts/probe-book-cancel-uk.ts` — UK-region variant (databaseRegion, country handling).
- `npx tsx scripts/probe-find-slots-raw.ts` — dumps the raw GraphQL availability response (useful when re-capturing persisted-query hashes).
- `npx tsx scripts/probe-list-res.ts` — dump upcoming reservations; useful after a probe to check for dangling ones.
- `npx tsx scripts/serve-only.ts` — raw WS listener that logs every extension frame. Debugging only.
- `npx tsx scripts/e2e-phase-a.ts` — read-only smoke (list reservations / profile / favorites).

All `probe-*.ts` / `e2e-*.ts` scripts require the extension loaded at `chrome://extensions` and a signed-in opentable tab.

## Architecture

```
┌────────────────┐  stdio   ┌──────────────────┐   WS   ┌────────────┐    fetch()    ┌─────────────┐
│ MCP client     │◀────────▶│  dist/bundle.js  │◀──────▶│ extension  │◀────────────▶│ opentable   │
│ (Claude, etc.) │          │  (OpenTable MCP) │ :37149 │ (SW + CS)  │   (real TLS, │ .com (tab)  │
└────────────────┘          └──────────────────┘        └────────────┘   cookies)    └─────────────┘
```

- **`src/ws-server.ts`** — `OpenTableWsServer`: 127.0.0.1:37149 listener. Accepts one extension, routes `fetch` RPCs, 20s ping, 15s connect timeout, 30s request timeout.
- **`src/client.ts`** — `OpenTableClient`: thin wrapper around the WS server. `fetchHtml(path)` for GETs that return HTML, `fetchJson(path, init)` for JSON POSTs/DELETEs. Maps non-2xx, empty-body (204), and sign-in-page responses into typed errors.
- **`src/tools/*.ts`** — one file per concern (reservations, restaurants, favorites, search, user). Each exports `registerXxxTools(server, client)`. See "Tool surface" below.
- **`src/parse-*.ts`** — pure HTML/JSON parsers. Fully unit-tested.
- **`src/initial-state.ts`** — extracts `window.__INITIAL_STATE__` from SSR HTML pages.
- **`src/booking-token.ts`** — encodes/decodes the opaque, stateless base64-JSON `booking_token` that bridges `opentable_book_preview` → `opentable_book` with a tamper check.
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

Note: `manifest.json` historically lists only 10 tools (missing `opentable_book_preview`); the runtime registers 11. The release workflow rewrites versions but not the tool list — if you change the tool surface, update `manifest.json` by hand.

## Environment

No environment variables required. Auth lives in the user's browser via the companion extension. `.env.example` is kept as a marker only.

## Conventions

- All tools are `opentable_*`-prefixed.
- Tool return shape: `{ content: [{ type: 'text', text: JSON.stringify(..., null, 2) }] }`.
- Readonly tools set `annotations: { readOnlyHint: true }`.
- Prefer JSON bodies. The write tools hit OpenTable's internal JSON/GraphQL endpoints; don't use `URLSearchParams` unless an endpoint explicitly requires form-encoding.
- Write a failing test before implementation (TDD). Tool tests live in `tests/tools/<name>.test.ts` and mock `OpenTableClient.fetchJson` / `fetchHtml`.
- Prefer Apollo persisted queries (just the `sha256Hash`, no GraphQL body). Hashes are pinned at the top of the tool file — if OpenTable re-deploys, the server returns `PersistedQueryNotFound` and the hashes need re-capture via the extension's XHR logger.

## Testing

Tests live in `tests/`, a 1:1 mirror of `src/`. Run with `npm test` (vitest). All fetches are mocked — no real network. `vitest.config.ts` enables v8 coverage reporting (`npm run test:coverage`) but does not enforce thresholds.

## Versioning

Version appears in SIX places — all must match:

1. `package.json` → `"version"`
2. `package-lock.json` → kept in sync by `npm version` / `npm install --package-lock-only`
3. `src/index.ts` → `McpServer` constructor `version` field (and the startup `console.error` banner)
4. `manifest.json` → `"version"`
5. `server.json` → `"version"` and `packages[].version`
6. `.claude-plugin/plugin.json` → `"version"` AND `.claude-plugin/marketplace.json` → `metadata.version` + `plugins[].version`

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. Versioning is handled by the **Tag & Bump** GitHub Action (`.github/workflows/tag-and-bump.yml`).

### Release workflow

Main is always one version ahead of the latest tag. To release, run the **Tag & Bump** GitHub Action which:

1. Runs CI (`.github/workflows/ci.yml`: build + test)
2. Tags the current commit with the current version
3. Bumps patch via `npm version patch` and `sed`s `src/index.ts` + rewrites `manifest.json`
4. Rebuilds, commits, and pushes main + tag
5. The tag push triggers `.github/workflows/release.yml` (CI + `.mcpb` pack + `.skill` zip + npm publish + MCP registry + ClawHub + GitHub release with auto-generated notes)

`release.yml` also normalises `server.json`, `manifest.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` to the tag version on every release — so a stale version in those files at build time is recoverable; a stale version in `src/index.ts` (the banner) is not.

## Hot spots / gotchas

- **`/r/<numeric-id>` 404s.** OpenTable's restaurant URLs use slugs (`/r/state-of-confusion-charlotte`), not numeric IDs. `opentable_book` therefore requires `dining_area_id` as an explicit arg — call `opentable_get_restaurant` with a slug first to read `diningAreas[]`.
- **Content scripts don't survive extension reload.** Existing opentable tabs lose `content.js` + `capture-logger.js` when the extension reloads. The background SW re-injects them automatically (onInstalled/onStartup + fallback on `sendMessage` failure). If a user hits "Could not establish connection" errors, reloading the extension once should fix it permanently.
- **MV3 service worker sleeps.** Idle SWs get killed after ~30s. We hold a 20s ping to the server and a 25s `chrome.alarms` tick. Cold wake can delay the first request by up to ~5s.
- **CSRF tokens live on `window.__CSRF_TOKEN__`** (MAIN world) but `content.js` runs in an isolated world. `capture-logger.js` syncs the token to `document.documentElement.dataset.otMcpCsrf` every 2s so `content.js` can include it in headers for write endpoints.
- **Persisted-query cache lag on `/user/favorites`.** After `add_favorite` returns 204, the SSR dashboard may not reflect the new entry for ~10s. Document this in the tool description, don't fight the cache.
- **Sign-in detection.** `OpenTableClient.throwIfSignInPage` checks for `/authenticate/` in the response URL or sign-in markers in a short response body. When it throws, the user must sign into opentable.com in the bridged Chrome tab.
- **CC-required slots route through preview.** The slot-lock response doesn't carry the CC-required flag or cancellation policy — those live in the `/booking/details` SSR page's `__INITIAL_STATE__` (`timeSlot.creditCardRequired`, `messages.cancellationPolicyMessage`, `wallet.savedCards`). `opentable_book_preview` fetches that page + slot-locks, and mints a `booking_token` that `opentable_book` consumes. `booking_token` is opaque, stateless base64-JSON — no server-side cache — with a tamper check (restaurant/date/time/party/dining-area must match the caller's own args). OpenTable's ~90s slot-lock TTL is the only expiry; a stale token surfaces as `SLOT_LOCK_EXPIRED` which `opentable_book` maps to an actionable error.
- **Same-day conflicts.** OpenTable refuses two reservations on the same date. Both `opentable_book` and `opentable_book_preview` parse `/booking/details` for overlapping reservations and fail early with a human-readable error rather than letting `/dapi/booking/make-reservation` return an opaque 409.
- **3-D Secure (SCA).** If a card's issuer demands a 3DS challenge on book, we can't complete it from outside the browser. `opentable_book` surfaces `partnerScaRedirectUrl` and bails — rare for pre-authenticated saved cards.

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

<!-- pr-workflow:v1 -->
## Pull requests & release notes

**Default workflow: branch + PR, even for solo work.** Direct pushes to `main` skip review *and* skip auto-generated release notes — GitHub's `generate_release_notes` (configured in `.github/release.yml`) only picks up merged PRs. Push directly to `main` only when the user explicitly asks for it (e.g. emergency hotfix).

For every PR, apply exactly one label so it lands in the right release-notes section:

| Label                | Section in release notes |
|----------------------|--------------------------|
| `enhancement`        | Features                 |
| `bug`                | Bug Fixes                |
| `security`           | Security                 |
| `refactor`           | Refactor                 |
| `documentation`      | Documentation            |
| `test`               | Tests                    |
| `dependencies`       | Dependencies             |
| `ci` / `github_actions` | CI & Build            |
| *(none / unmatched)* | Other Changes            |
| `ignore-for-release` | Hidden from notes        |

The **PR title** becomes the bullet — write it like a user-facing changelog entry (`opentable_book_preview: refuse stale booking tokens`), not internal shorthand (`book tweaks`). Conventional-commit prefixes (`feat:`, `fix:`, `chore:`) are still fine in commit messages, but the PR title should read clean.

Open with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a line), then **immediately** run `gh pr merge <num> --auto --merge` so the PR merges as soon as CI passes. The repo allows merge commits only (no squash, no rebase) — don't pass `--squash`/`--rebase` or the call will fail.
