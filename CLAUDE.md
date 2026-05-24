# CLAUDE.md — opentable-mcp

Guidance for Claude working in this repo.

## TL;DR

v0.9.1: OpenTable MCP server with 13 tools (read + write), fronted by a
pluggable browser bridge. Default transport: localhost WebSocket via
[`@fetchproxy/server`](https://github.com/chrischall/fetchproxy) — the
companion browser extension is installed separately (Chrome Web Store /
Safari .dmg) rather than embedded in this repo. Opt-in alternative:
`OT_BRIDGE=mcp-chrome` routes through hangwin/mcp-chrome's HTTP MCP
endpoint instead. Either way, Akamai sees a real browser fetch — never
us directly.

## Bridge selection

`OT_BRIDGE` env var picks the transport:

- `OT_BRIDGE=websocket` (default) — wraps `@fetchproxy/server`'s
  `FetchproxyServer` (WebSocket on 127.0.0.1:37149; override with
  `OT_WS_PORT`). The user installs the fetchproxy extension once
  (Chrome / Safari) instead of loading a per-MCP embedded extension.
  See https://github.com/chrischall/fetchproxy.
- `OT_BRIDGE=mcp-chrome` — talks to hangwin/mcp-chrome at
  `http://127.0.0.1:12306/mcp` (override with `OT_MCP_CHROME_URL`).
  Requires mcp-chrome ≥ the release containing
  [PR #348](https://github.com/hangwin/mcp-chrome/pull/348) — the
  `tabUrl` parameter on `chrome_network_request`. Pre-PR mcp-chrome
  versions are active-tab-only and break credentialed cross-origin
  fetches. Live-verification of this path is pending the upstream merge.

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

All `probe-*.ts` / `e2e-*.ts` scripts require the fetchproxy extension installed and a signed-in opentable tab.

## Architecture

```
┌────────────────┐  stdio   ┌──────────────────┐   WS   ┌──────────────────┐    fetch()    ┌─────────────┐
│ MCP client     │◀────────▶│  dist/bundle.js  │◀──────▶│  fetchproxy      │◀────────────▶│ opentable   │
│ (Claude, etc.) │          │  (OpenTable MCP) │ :37149 │  extension       │   (real TLS, │ .com (tab)  │
└────────────────┘          └──────────────────┘        │  (separate)      │   cookies)    └─────────────┘
                                    │                   └──────────────────┘
                                    │ depends on
                                    ▼
                            @fetchproxy/server (npm)
```

- **Dependency on `@fetchproxy/server`** — the WebSocket server, frame validation, and browser extension all live in the separate https://github.com/chrischall/fetchproxy repo. Releases there ship `@fetchproxy/server` to npm and `fetchproxy-extension` to the Chrome Web Store / Safari. opentable-mcp pins both as runtime deps (`@fetchproxy/server`, `@fetchproxy/protocol`). The cross-repo split lets resy-mcp, future *.com-mcp servers, etc. share one extension instead of bundling their own.
- **`src/transport.ts`** — the `OpenTableTransport` interface (`start/close/fetch`) and shared `FetchInit`/`FetchResult` types. Two implementations:
  - **`src/transport-fetchproxy.ts`** — `FetchproxyTransport`: thin adapter that wraps `@fetchproxy/server`'s `FetchproxyServer`. opentable-mcp passes opentable-relative paths (`/dapi/...`); the adapter prepends `https://www.opentable.com` and pins `tabUrl` to opentable.com so the extension routes fetches through the right tab.
  - **`src/transport-mcp-chrome.ts`** — `McpChromeTransport`: opt-in via `OT_BRIDGE=mcp-chrome`. Talks to hangwin/mcp-chrome's HTTP MCP at `127.0.0.1:12306/mcp`. Each fetch maps to a `chrome_network_request` call pinned to `tabUrl: "https://www.opentable.com/"`. Requires the `tabUrl` param landing upstream — see https://github.com/hangwin/mcp-chrome/pull/348.
- **`src/client.ts`** — `OpenTableClient`: thin facade over `OpenTableTransport`. `fetchHtml(path)` for GETs that return HTML, `fetchJson(path, init)` for JSON POSTs/DELETEs. Maps non-2xx, empty-body (204), and sign-in-page responses into typed errors. Transport-agnostic.
- **`src/tools/*.ts`** — one file per concern (reservations, restaurants, favorites, search, user). Each exports `registerXxxTools(server, client)`. See "Tool surface" below.
- **`src/parse-*.ts`** — pure HTML/JSON parsers. Fully unit-tested.
- **`src/initial-state.ts`** — extracts `window.__INITIAL_STATE__` from SSR HTML pages.
- **`src/booking-token.ts`** — encodes/decodes the opaque, stateless base64-JSON `booking_token` that bridges `opentable_book_preview` → `opentable_book` with a tamper check.
- **`tests/`** — 1:1 mirror of `src/`. `tests/helpers.ts` provides an in-memory MCP harness (stdio transports on a PassThrough pair) for tool tests. WS-protocol-level tests now live upstream in the fetchproxy repo.

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

Note: `manifest.json` now lists all 13 tools (was historically out of sync — `opentable_book_preview` was missing). The release workflow rewrites versions but not the tool list — if you change the tool surface, update `manifest.json` by hand.

## Environment

No environment variables required. Auth lives in the user's browser via the companion extension. `.env.example` is kept as a marker only.

## Conventions

- All tools are `opentable_*`-prefixed.
- Tool return shape: `{ content: [{ type: 'text', text: JSON.stringify(..., null, 2) }] }`.
- Readonly tools set `annotations: { readOnlyHint: true }`.
- Prefer JSON bodies. The write tools hit OpenTable's internal JSON/GraphQL endpoints; don't use `URLSearchParams` unless an endpoint explicitly requires form-encoding.
- Write a failing test before implementation (TDD). Tool tests live in `tests/tools/<name>.test.ts` and mock `OpenTableClient.fetchJson` / `fetchHtml`.
- Prefer Apollo persisted queries (just the `sha256Hash`, no GraphQL body). Hashes are pinned at the top of the tool file — if OpenTable re-deploys, the server returns `PersistedQueryNotFound` and the hashes need re-capture. Fastest re-capture path: on the page where the op fires (e.g. `/booking/details` for slot-lock ops), once the mutation has run, read `window.__APOLLO_CLIENT__.queryManager.mutationStore['1'].mutation.documentId` from DevTools — Apollo's `documentId` IS the persisted-query sha256Hash. For queries, iterate `queryManager.queries.forEach((q) => q.document.documentId)`. Beats the XHR-logger approach because the cookie/CSRF stays in the page and there's nothing to copy out of a request body.

## Testing

Tests live in `tests/`, a 1:1 mirror of `src/`. Run with `npm test` (vitest). All fetches are mocked — no real network. `vitest.config.ts` enables v8 coverage reporting (`npm run test:coverage`) but does not enforce thresholds.

## Publishing constraints

The MCP Registry's [server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) caps `server.json`'s `description` at **100 characters**. Values over that fail `mcp-publisher publish` with HTTP 422 (`validation failed: expected length <= 100, location: body.description`). The other description fields (`manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) have no published length constraint and can stay longer.

Sanity-check before committing a description change:

```bash
jq -r '.description | length' server.json
```

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
- **Extension lifecycle is owned by `@fetchproxy/server`.** Self-healing content scripts, MV3 service-worker keepalive, and CSRF token handling all live upstream in the fetchproxy extension. If a user hits "extension offline" or "Could not establish connection", point them at the fetchproxy installation docs — there's nothing for opentable-mcp to fix.
- **Persisted-query cache lag on `/user/favorites`.** After `add_favorite` returns 204, the SSR dashboard may not reflect the new entry for ~10s. Document this in the tool description, don't fight the cache.
- **Sign-in detection.** `OpenTableClient.throwIfSignInPage` checks for `/authenticate/` in the response URL or sign-in markers in a short response body. When it throws, the user must sign into opentable.com in the bridged Chrome tab.
- **CC-required slots route through preview.** The slot-lock response doesn't carry the CC-required flag or cancellation policy — those live in the `/booking/details` SSR page's `__INITIAL_STATE__` (`timeSlot.creditCardRequired`, `messages.cancellationPolicyMessage`, `wallet.savedCards`). `opentable_book_preview` fetches that page + slot-locks, and mints a `booking_token` that `opentable_book` consumes. `booking_token` is opaque, stateless base64-JSON — no server-side cache — with a tamper check (restaurant/date/time/party/dining-area must match the caller's own args). OpenTable's ~90s slot-lock TTL is the only expiry; a stale token surfaces as `SLOT_LOCK_EXPIRED` which `opentable_book` maps to an actionable error.
- **Same-day conflicts.** OpenTable refuses two reservations on the same date. Both `opentable_book` and `opentable_book_preview` parse `/booking/details` for overlapping reservations and fail early with a human-readable error rather than letting `/dapi/booking/make-reservation` return an opaque 409.
- **3-D Secure (SCA).** If a card's issuer demands a 3DS challenge on book, we can't complete it from outside the browser. `opentable_book` surfaces `partnerScaRedirectUrl` and bails — rare for pre-authenticated saved cards.
- **Experience-mandatory slots use a separate slot-lock op.**
  `BookDetailsExperienceSlotLock` (persisted-query hash captured
  2026-05-20 against Pasqual's) replaces `BookDetailsStandardSlotLock`
  when `slot.type === "Experience"`. The `/booking/details` URL also
  picks up `experienceIds`, `selectedExperience`, `tableCategory`,
  `st=Experience`, and `isMandatory=true` query params, which let us
  skip the `seating-options` and `specials` intermediate pages the
  browser UI walks through. If OpenTable redeploys and invalidates the
  Experience hash, run `scripts/probe-experience-slot-lock-hash.ts`
  against Pasqual's to re-capture.
- **Listing-only restaurants can't be booked through OpenTable.**
  `restaurant.type === "Listing"` (Le Bernardin's classification, e.g.)
  surfaces as `bookable: false` on `opentable_get_restaurant`. There's
  no slot picker; agents should surface the restaurant's phone + URL
  rather than call `opentable_book`.
- **Modify uses the same SSR + slot-lock as book, with three URL markers.** `/booking/details?confirmationNumber=<n>&securityToken=<t>&isModify=true&…<new-slot-params>` returns the modify state. The `make-reservation` body for the modify path keys off `confnumber` (lowercase, no underscore — OpenTable's quirky shorthand) + `securityToken`; `reservationId` is NOT allowed in the modify body even though the SSR state's `modifyReservation.gpid` looks like it should be the identifier. The same-day-conflict helper takes an `excludeConfirmation` arg — `opentable_modify_preview` uses it to avoid false-positives against the reservation being moved.

## Live probing workflow

1. `npm run build` — keep `dist/bundle.js` fresh.
2. `lsof -ti :37149 | xargs -r kill` — clear any orphan MCP server from a prior crashed probe.
3. `npx tsx scripts/probe-<x>.ts` — the probe spawns its own `dist/bundle.js` over stdio. The fetchproxy extension reconnects within ~2s and announces `ready` once it finds an opentable.com tab.
4. If the first call fails with "extension offline", the extension is probably sleeping — reopen the popup or reload it once.

## What to *not* do

- Don't add new transport-layer hacks (cycletls, impersonate-curl, Playwright). v0.2 tried those; Akamai wins. The fetchproxy bridge is the whole design.
- Don't paste cookies or env-configure auth. Auth lives in the user's browser now.
- Don't register tools that can't be tested against a mock `OpenTableClient`. All tool logic should be behind `fetchJson` / `fetchHtml` so tests can drive it without a real WS.
- Don't bump the persisted-query hashes speculatively. Only re-capture when a live request fails with `PersistedQueryNotFound`.
- Don't add WS-server or protocol-frame logic here. That lives upstream in `@fetchproxy/server`. Bugs in extension handshaking, frame validation, or service-worker keepalive should be filed against the fetchproxy repo.

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

### How PRs merge

**Do not manually merge PRs — including the release-please release PR.** Open with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line). That is the whole job. Do **not** run `gh pr merge --auto --squash` yourself.

The automation handles the rest:

1. `pr-auto-review.yml` runs a Claude review on every PR. On a `pass` verdict it adds the `ready-to-merge` label.
2. `release-please.yml` adds the `ready-to-merge` label to its own release PR automatically.
3. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash` for you. The moment CI is green the PR squash-merges itself.

If Claude's review verdict was `warn` or `fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`. The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.
