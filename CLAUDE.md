# CLAUDE.md — opentable-mcp

Guidance for Claude working in this repo.

## TL;DR

OpenTable MCP server with 13 tools (read + write), fronted by a
pluggable browser bridge. Default transport: localhost WebSocket via
[`@fetchproxy/server`](https://github.com/chrischall/fetchproxy) — the
companion browser extension is installed separately (Chrome Web Store /
Safari .dmg) rather than embedded in this repo. Opt-in alternative:
`OT_BRIDGE=mcp-chrome` routes through hangwin/mcp-chrome's HTTP MCP
endpoint instead. Either way, every request rides the user's own browser
session — their cookies, their TLS, their JS context — never ours.

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
- `npx tsx scripts/probe-book-cancel-experience.ts` — **books + cancels a real Experience-mandatory slot** (book_preview → book path; targets Cafe Pasqual's).
- `npx tsx scripts/probe-modify-experience.ts` — **books → modifies (moves time) → cancels** a real reservation; the live truth-check for the modify path.
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
- **`src/tools/*.ts`** — one file per concern (reservations, restaurants, favorites, search, user). Each exports `registerXxxTools(server, client)`. See "Tool surface" below. `tools/booking-flow.ts` is the exception: not a tool registrar but the shared booking primitives (`lockSlot`, `makeReservation`) behind `opentable_book`/`opentable_book_preview` and `opentable_modify`/`opentable_modify_preview` — it hides the Standard-vs-Experience and new-book-vs-modify body/response divergence. The persisted-query hashes + endpoint paths stay in `tools/reservations.ts` and are passed in.
- **`src/parse-*.ts`** — pure HTML/JSON parsers. Fully unit-tested.
- **`src/initial-state.ts`** — extracts `window.__INITIAL_STATE__` from SSR HTML pages.
- **`src/booking-token.ts`** — encodes/decodes the opaque, stateless base64-JSON `booking_token` that bridges `opentable_book_preview` → `opentable_book` with a tamper check.
- **`tests/`** — 1:1 mirror of `src/`. `tests/helpers.ts` re-exports the in-memory MCP harness (`createTestHarness`, `parseToolResult`) from `@chrischall/mcp-utils/test` so the existing `../helpers.js` call sites keep working. WS-protocol-level tests now live upstream in the fetchproxy repo.
- **`@chrischall/mcp-utils`** — shared helper package used across the fleet (also imported throughout `src/`, e.g. `readEnvVar`, error/result helpers). Its `/test` entry provides the test harness and the `versionSyncTest` drift guard.

## Tool surface

| Tool | File | Endpoint(s) | Kind |
| --- | --- | --- | --- |
| `opentable_list_reservations` | `tools/reservations.ts` | GET `/user/dining-dashboard` SSR | read |
| `opentable_get_profile` | `tools/user.ts` | GET `/user/dining-dashboard` SSR | read |
| `opentable_list_favorites` | `tools/favorites.ts` | GET `/user/favorites` SSR | read |
| `opentable_search_restaurants` | `tools/search.ts` | POST `/dapi/fe/gql?opname=Autocomplete` | read |
| `opentable_get_restaurant` | `tools/restaurants.ts` | GET `/r/{slug}` SSR (falls back to legacy root `/{slug}`) | read |
| `opentable_find_slots` | `tools/reservations.ts` | POST `/dapi/fe/gql?opname=RestaurantsAvailability` | read |
| `opentable_book_preview` | `tools/reservations.ts` | GET `/booking/details` SSR + POST `BookDetailsStandardSlotLock` | read |
| `opentable_book` | `tools/reservations.ts` | (token path) POST `/dapi/booking/make-reservation`; (no-token path) GET `/booking/details` SSR + POST `BookDetailsStandardSlotLock` → POST `/dapi/booking/make-reservation` | write |
| `opentable_modify_preview` | `tools/reservations.ts` | GET `/booking/details?…&isModify=true` SSR + POST `BookDetailsStandardSlotLock` | read |
| `opentable_modify` | `tools/reservations.ts` | GET `/booking/details?…&isModify=true` SSR + slot-lock → POST `/dapi/booking/make-reservation` (`isModify: true`) | write |
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
3. `src/index.ts` → the `VERSION` const (tagged `// x-release-please-version`), fed to the `McpServer` constructor and the startup `console.error` banner. `tests/version-sync.test.ts` (via `@chrischall/mcp-utils/test`'s `versionSyncTest`) fails CI if this annotation drifts from `package.json`.
4. `manifest.json` → `"version"`
5. `server.json` → `"version"` and `packages[].version`
6. `.claude-plugin/plugin.json` → `"version"` AND `.claude-plugin/marketplace.json` → `metadata.version` + `plugins[].version`

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. Versioning is handled by **release-please** (`.github/workflows/release-please.yml`). `release-please-config.json` registers all of the files above as `extra-files`, so a single release PR bumps them in lockstep.

### Release workflow

Commits land on `main` via PR. release-please (`.github/workflows/release-please.yml`) opens or updates a `chore(main): release X.Y.Z` PR whenever Conventional-Commit messages (`feat:`, `fix:`, etc.) accumulate. Merging the release PR (arm `ready-to-merge`) creates the tag and a GitHub Release; the `publish` job then packs the `.mcpb` bundle and `.skill` archive, publishes to npm with provenance, and pushes to the MCP Registry.

## Hot spots / gotchas

- **`/r/<numeric-id>` 404s.** OpenTable's restaurant URLs use slugs (`/r/state-of-confusion-charlotte`), not numeric IDs. `opentable_get_restaurant` rejects numeric ids up front with an actionable error rather than fetching a doomed `/r/<id>`.
- **`dining_area_id` is auto-resolved — booking no longer depends on `get_restaurant`.** `opentable_book` / `opentable_book_preview` take `dining_area_id` as an *optional* arg. When omitted, it's resolved from the `/booking/details` page they already fetch: `timeSlot.diningAreasBySeating[]` carries `{diningAreaId, tableCategory}`, and `resolveDiningAreaId()` (in `parse-booking-details-state.ts`) picks the first entry matching the seating (default `default`), falling back to the first area. So `find_slots → book` works with no separate lookup; pass `dining_area_id` explicitly only to pin a specific room. Why this design: the `RestaurantsAvailability` response (find_slots) carries only the seating *category* (`attributes`, `diningAreasBySeating[].tableCategory`) — **not** the numeric `diningAreaId` (the `SlotDiningArea` objects there expose only `inventoryAccessRuleMap`). The numeric id lives only on `/booking/details`, so that's where we resolve it. Confirmed live 2026-06-03: `/booking/details` returns the full `diningAreasBySeating[]` whether or not `diningAreaId` is in the URL. Note: `opentable_modify` / `opentable_modify_preview` still require an explicit `dining_area_id`.
- **`opentable_get_restaurant` does not surface dining areas.** Despite older tool copy, `parse-restaurant.ts` never extracted `diningAreas[]`. Don't rely on it for `dining_area_id` — use the auto-resolution above (or read the ids from a `book_preview` response's `reservation.dining_area_id`).
- **Legacy detail pages live at root `/{slug}`, not `/r/{slug}`.** A subset of (older) listings — e.g. The Cellar at Duckworth's (`/the-cellar-at-duckworths`) — are served at the root path. `opentable_get_restaurant` accepts a slug, an absolute path, or a full URL: a path/URL is fetched verbatim (pass the search result's `url` for a guaranteed hit), while a bare slug tries `/r/{slug}` then falls back to `/{slug}` on a 404. The output `url` echoes whichever path actually resolved, so it stays clickable. See `resolveCandidatePaths` in `src/tools/restaurants.ts`.
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
- **`database_region` defaults to `'NA'` and is not auto-derived.** OpenTable shards reservation data by region; the slot-lock, `RestaurantsAvailability`, and cancel mutations all carry a `databaseRegion` field. `find_slots` / `book_preview` / `book` / `modify_preview` / `cancel` take an **optional** `database_region` input that defaults to `'NA'` (North America). We can't derive it automatically: the booking flow works from `restaurant_id` + slot tokens and never fetches the detail page, and neither the availability response nor the `/booking/details` SSR state surfaces OpenTable's `databaseRegion` enum (the restaurant SSR carries a postal `country`, not the shard id). So a non-NA (UK/EU/APAC) booking or cancel must pass the venue's region explicitly — otherwise it slot-locks/cancels against the wrong shard or fails opaquely. `DEFAULT_DATABASE_REGION` + the `DatabaseRegion` zod schema live at the top of `tools/reservations.ts`; the exact non-NA region string still needs a live capture to confirm — `scripts/probe-book-cancel-uk.ts` is the vehicle.
- **Modify uses the same SSR + slot-lock as book, with three URL markers.** `/booking/details?confirmationNumber=<n>&securityToken=<t>&isModify=true&…<new-slot-params>` returns the modify state. The `make-reservation` body for the modify path keys off `confnumber` (lowercase, no underscore — OpenTable's quirky shorthand) + `securityToken`; `reservationId` is NOT allowed in the modify body even though the SSR state's `modifyReservation.gpid` looks like it should be the identifier. The same-day-conflict helper takes an `excludeConfirmation` arg — `opentable_modify_preview` uses it to avoid false-positives against the reservation being moved.

## Live probing workflow

1. `npm run build` — keep `dist/bundle.js` fresh.
2. `lsof -ti :37149 | xargs -r kill` — clear any orphan MCP server from a prior crashed probe.
3. `npx tsx scripts/probe-<x>.ts` — the probe spawns its own `dist/bundle.js` over stdio. The fetchproxy extension reconnects within ~2s and announces `ready` once it finds an opentable.com tab.
4. If the first call fails with "extension offline", the extension is probably sleeping — reopen the popup or reload it once.

## What to *not* do

- Don't add new transport-layer libraries (cycletls, impersonate-curl, Playwright). v0.2 tried those, and each one builds a separate stand-in identity that the rest of the design has to compensate for. The whole point is to ride the user's own session via fetchproxy — don't replace it with a different client.
- Don't paste cookies or env-configure auth. Auth lives in the user's browser now.
- Don't register tools that can't be tested against a mock `OpenTableClient`. All tool logic should be behind `fetchJson` / `fetchHtml` so tests can drive it without a real WS.
- Don't bump the persisted-query hashes speculatively. Only re-capture when a live request fails with `PersistedQueryNotFound`.
- Don't add WS-server or protocol-frame logic here. That lives upstream in `@fetchproxy/server`. Bugs in extension handshaking, frame validation, or service-worker keepalive should be filed against the fetchproxy repo.

<!-- pr-workflow:v2 -->
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

**Exception for first-party dependency bumps.** When bumping a package we own (currently `@fetchproxy/server` — anything published from a chrischall-owned repo), label the PR `enhancement` or `bug` instead of `dependencies`, and use the matching commit prefix (`feat:` or `fix:`) instead of `chore:`. Those bumps deliver real product fixes or features through us, so they should drive a release-please version bump and show up under Features/Bug Fixes in the release notes — not get hidden under "Dependencies" (which doesn't trigger a release).

The **PR title MUST be a Conventional Commit**, written user-facing (`fix(scope): …`, `feat(scope): …`), not internal shorthand. Because the repo squash-merges, the PR title *becomes the squash commit's subject line* — the only thing release-please parses to pick the version bump and changelog section. Only `feat` (minor), `fix` (patch), and `!`/`BREAKING CHANGE` (major) cut a release; `perf`/`refactor`/`docs`/`revert` show in the changelog without bumping; `ci`/`test`/`build`/`chore` are recognised but hidden (see `release-please-config.json` → `changelog-sections`). A title without a conventional type is invisible to release-please — no bump, no changelog line. Prefixes in *individual commits* don't help; squash keeps only the title.

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation does it:

1. `pr-auto-review.yml` (a thin stub over `chrischall/workflows`) runs a Claude review on every PR **except** the release-please release PR (which it deliberately skips). A `pass` **or** `warn` verdict arms the `ready-to-merge` label; `warn` (nits only) still merges. A `fail` verdict blocks the merge until the important findings are addressed. Both `warn` and `fail` also open/update an `auto-review-followup` issue (see below).
2. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash`. The moment CI is green the PR squash-merges itself.

For ordinary feature/fix PRs, opening with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line) is the whole job. If Claude's verdict was `fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`.

### Auto-review follow-up issues

When a PR's auto-review verdict is `warn` or `fail`, the `chrischall/workflows` pipeline opens or updates a single `auto-review-followup` issue ("Auto-review follow-ups for PR #N") whose checklist captures every finding, and links it from the PR's `<!-- auto-review-verdict -->` comment (`📋 Tracking follow-ups: #N`). `warn` (nits only) still auto-merges — the issue carries the nits forward, so most nits are fixed in a *later* PR; `fail` blocks until the important findings are addressed on the PR itself.

When asked to address the auto-review comments / review findings on a PR:

1. Read the verdict comment, open the linked `auto-review-followup` issue, and treat its checklist as the work list (alongside any inline review comments).
2. Resolve each item, checking off only what you've **verified** is genuinely fixed.
3. If every item is resolved on the current PR, add `Closes #<issue>` to that PR's body so the merge closes it; if some are deferred, check off only the resolved ones and leave the issue open.
4. For nits whose `warn` PR already auto-merged, address them in a follow-up PR that references `Closes #<issue>`.

(Mirrors the fleet-wide convention in `~/.claude/CLAUDE.md`.)

### PR timing — only open when the feature is done

Because PRs auto-merge as soon as auto-review passes, **do not open a PR until the feature is genuinely complete**. There's no draft-PR safety net here:

- Don't open a PR to "stage" work while live verification, follow-up fixes, or final passes are still pending — by the time you finish those, the half-baked PR may already be in `main`.
- Push commits to the branch first; only run `gh pr create` once tests pass, live verification (if applicable) is green, and you'd be comfortable with the change shipping as-is.
- If follow-ups land after a PR is already open, they need to land on the same branch *before* auto-review flips to `pass`. Once the PR squash-merges, late commits orphan onto a stale branch and become their own follow-up PR.
- If you genuinely need a checkpoint review without shipping, open the PR as a GitHub draft (`gh pr create --draft …`) — auto-review skips drafts. Mark it ready-for-review only when the feature is truly done.

**Release PRs are the one manual touch.** release-please opens its own release PR and leaves it open as your staging artifact — `pr-auto-review.yml` skips it on purpose, so it sits there accumulating changes until you decide to ship. When you're ready, add `ready-to-merge` to it the same way: `gh pr edit <num> --add-label ready-to-merge`. The `auto-merge.yml` arm then takes over and the publish job fires the moment the release PR lands.

The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.
