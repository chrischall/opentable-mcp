# OpenTable MCP — Design

## Purpose

Expose OpenTable reservation management (search, book, list, cancel, favorites, notify) as an MCP server for Claude, matching the conventions of the user's existing MCPs (`resy-mcp`, `ofw-mcp`, `splitwise-mcp`). Domain shape drawn from `markswendsen-code/mcp-opentable` (Playwright-based reference); architecture drawn from `resy-mcp` (thin HTTP client).

## Non-goals

- Browser automation. No Playwright / Puppeteer. All access via HTTP.
- Hosted deployment, HTTP/SSE transport, or web UI. Stdio only.
- MFA / 2FA login. If an account has MFA enabled, the spec instructs the user to disable it or use an app-specific credential. Revisit if we hit it.
- Guest (non-authenticated) bookings. Login is required.
- Writing restaurant reviews, photos, or any social features.

## Architecture

```
opentable-mcp/
├── .github/workflows/
│   ├── ci.yml
│   ├── release.yml
│   └── tag-and-bump.yml
├── src/
│   ├── index.ts              # MCP server bootstrap, tool registration
│   ├── client.ts             # OpenTableClient: auth + cookie jar + request + retry
│   └── tools/
│       ├── user.ts
│       ├── restaurants.ts    # search + get-details
│       ├── reservations.ts   # find-slots + book + list + cancel
│       ├── favorites.ts
│       └── notify.ts
├── tests/
│   ├── client.test.ts
│   ├── helpers.ts
│   └── tools/
│       ├── user.test.ts
│       ├── restaurants.test.ts
│       ├── reservations.test.ts
│       ├── favorites.test.ts
│       └── notify.test.ts
├── scripts/
│   └── smoke.ts              # read-only live probe; output gitignored
├── docs/superpowers/specs/2026-04-20-opentable-mcp-design.md
├── .env.example
├── .gitignore
├── CLAUDE.md
├── README.md
├── manifest.json             # MCPB manifest with user_config prompts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

- **Language / runtime:** TypeScript, ESM, Node ≥ 18.
- **Build:** `tsc --noEmit` typecheck + `esbuild` bundle to `dist/bundle.js` (single file, `external:dotenv`).
- **Transport:** `StdioServerTransport` only.
- **Dependencies:** `@modelcontextprotocol/sdk`, `dotenv`, `zod`.
- **Dev dependencies:** `typescript`, `esbuild`, `vitest`, `@vitest/coverage-v8`, `@types/node`, `tsx`.
- **Tool naming:** `opentable_*` prefix. Readonly `annotations: { readOnlyHint: true }` on GET-ish tools.
- **Return shape:** `{ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }`.

## Auth flow

### Credentials capture

`manifest.json` `user_config`:
```json
"opentable_email": {
  "type": "string",
  "title": "OpenTable Email",
  "description": "Your OpenTable account email",
  "required": true
},
"opentable_password": {
  "type": "string",
  "title": "OpenTable Password",
  "description": "Your OpenTable account password",
  "required": true,
  "sensitive": true
}
```

Env propagated via `mcp_config.env`:
```
OPENTABLE_EMAIL=${user_config.opentable_email}
OPENTABLE_PASSWORD=${user_config.opentable_password}
```

### Constants

- `BASE_URL = "https://www.opentable.com"`
- `GRAPHQL_URL = "https://www.opentable.com/dtp/eatery/graphql"` — candidate; verify during implementation.

### Spoof headers on every request

```
Origin: https://www.opentable.com
Referer: https://www.opentable.com/
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
Accept: application/json, text/plain, */*
Accept-Language: en-US,en;q=0.9
Content-Type: application/json    (only when body is JSON)
```

If OpenTable requires `x-csrf-token`, the client fetches the token on first call (candidate source: a GET of `/` reading a meta tag or cookie) and includes it on subsequent write requests. Resolve source during implementation; see Open Questions.

### Cookie jar

OpenTable authenticates via session cookies rather than a bearer token, so `OpenTableClient` keeps an in-memory `Map<string, string>` cookie jar scoped to `www.opentable.com`:

- On every response, parse all `set-cookie` header values. For each, extract `name=value` (the portion before the first `;`). Update the map; ignore `Expires`, `Path`, `Domain`, `Secure`, `HttpOnly` directives (since the jar is scoped and process-lifetime only, we don't need them).
- On every request, emit `Cookie: k1=v1; k2=v2; ...` from the current jar (no header if jar is empty).
- Clear the jar on explicit logout (401/419 re-login path).
- Deletion via `max-age=0` or empty value: remove the key.

~40 lines of parsing. No external cookie-jar dependency.

### Login

- `POST /authenticate/api/login` (candidate — also try `/api/v2/users/login` and `/dtp/eatery/login` if 404) with `Content-Type: application/json`, body `{ "email": "...", "password": "..." }`.
- Success = 2xx response plus a `Set-Cookie` header containing at least one of: `OT_SESSION`, `otd`, `ot_session`, `OTUserInfo`, `ot_userid` (the same set the reference repo recognises).
- No expiry returned; treat session as valid until a 401/419 or a clearly-expired response body is observed.

### Retry / refresh

- **401 or 419** → clear cookie jar, re-login once, retry original request. On second failure throw `"OpenTable session rejected — verify OPENTABLE_EMAIL / OPENTABLE_PASSWORD"`.
- **429** → sleep 2000 ms, retry once. On second failure throw `"Rate limited by OpenTable API"`.
- **403** with body matching `/captcha|bot|challenge/i` → throw `"OpenTable bot-detection challenge. Try again later or log in via a browser on this machine first."` (Distinct from bad creds so the user doesn't chase the wrong thing.)
- **500** with body matching `/unauthorized|auth|session/i` → treat as auth failure (some APIs return 500 on stale tokens; resy does the same).
- Other non-2xx → `"OpenTable API error: {status} {statusText} for {method} {path}"`.

## Tool specifications

All tools return `{ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }`. Input schemas defined via `zod`.

### User

**`opentable_get_profile`** — readonly
- Inputs: none.
- Calls: `GET /api/v2/users/me` (candidate).
- Returns: `{ first_name, last_name, email, phone, loyalty_tier, member_since, points_balance }`. Any payment/card detail is stripped.

### Restaurants

**`opentable_search_restaurants`** — readonly
- Inputs:
  - `query?: string` — restaurant name or keyword.
  - `location: string` — city, neighborhood, or address text. Required (OpenTable search is location-driven).
  - `date: string` — `YYYY-MM-DD`.
  - `time?: string` — `HH:MM` (24h). If omitted, availability is broadened.
  - `party_size: number` — positive int.
  - `cuisine?: string`.
  - `price_range?: "$" | "$$" | "$$$" | "$$$$"`.
  - `limit?: number` — default 20.
- Calls: GraphQL search operation against `GRAPHQL_URL` (fallback: `GET /dtp/eatery/search?term=...&covers=...&dateTime=...`). Verify during implementation.
- Returns: array of `{ restaurant_id, name, cuisine, neighborhood, address_city, rating, review_count, price_range, url, slots: [{ reservation_token, date, time, party_size }] }`.

**`opentable_get_restaurant`** — readonly
- Inputs: `restaurant_id: string`.
- Calls: `GET /api/v2/restaurants/{id}` (candidate).
- Returns: `{ restaurant_id, name, description, cuisine, address, phone, hours, rating, review_count, price_range, features: string[], url }`.

### Reservations

**`opentable_find_slots`** — readonly
- Inputs: `restaurant_id: string`, `date: string`, `party_size: number`, `time?: string`.
- Calls: `GET /api/v2/restaurants/{id}/availability?date=...&party_size=...&time=...` (candidate).
- Returns: array of `{ reservation_token, date, time, party_size, type? }` sorted by time ascending. Tokens expire quickly; callers should book promptly.

**`opentable_book`** — composite, not readonly
- Inputs: `restaurant_id: string`, `date: string`, `party_size: number`, `desired_time?: string` (HH:MM), `special_requests?: string`.
- Flow:
  1. Internally call the find-slots endpoint for fresh `reservation_token`s.
  2. Pick slot by exact `desired_time` match; fall back to closest-time-by-minute-delta; fall back to first slot if `desired_time` is absent.
  3. If the API requires a separate "book intent" step (like resy's `book_token`), call `GET /api/v2/reservations/details?token=...` to obtain it. Verify during implementation.
  4. `POST /api/v2/restaurants/{id}/reservations` (candidate) with JSON `{ reservation_token, party_size, date, time, special_requests? }`.
- Returns: `{ reservation_id, confirmation_number, restaurant_name, restaurant_url, date, time, party_size, status }`.
- Errors:
  - No available slots → throw `"No available slots for this restaurant/date/party size. The restaurant may be fully booked."`.
  - Missing book token when required → throw `"OpenTable did not return a reservation token for this slot."`.

**`opentable_list_reservations`** — readonly
- Inputs: `scope?: "upcoming" | "past" | "all"` — default `"upcoming"`.
- Calls: `GET /api/v2/users/me/reservations?scope=...` (if supported) or fetch all and filter client-side by date. Verify during implementation.
- Returns: array of `{ reservation_id, confirmation_number, restaurant_name, date, time, party_size, status, special_requests? }`.

**`opentable_cancel`** — not readonly
- Inputs: `reservation_id: string`.
- Calls: `POST /api/v2/reservations/{reservation_id}/cancel` (candidate).
- Returns: `{ cancelled: boolean, raw: <server response> }`. `cancelled` is derived from positive/negative signals (`status === "cancelled"`, presence of `ok: true`, absence of `error` / `error_message`) — same probe pattern as `resy_cancel`. `raw` carries the full response so callers can see what actually happened.

### Favorites

> Endpoint paths below are candidates. Verify via smoke probe during implementation; adjust URL/body only — not scope.

**`opentable_list_favorites`** — readonly
- Calls: `GET /api/v2/users/me/favorites`.
- Returns: array of restaurant summaries (same shape as a single entry from `opentable_search_restaurants`, minus slots).

**`opentable_add_favorite`** — not readonly
- Inputs: `restaurant_id: string`.
- Calls: `POST /api/v2/users/me/favorites` with JSON `{ restaurant_id }`.
- Returns: `{ favorited: true, restaurant_id }`.

**`opentable_remove_favorite`** — not readonly
- Inputs: `restaurant_id: string`.
- Calls: `DELETE /api/v2/users/me/favorites/{restaurant_id}`.
- Returns: `{ removed: true, restaurant_id }`.

### Notify

> Same candidate-endpoint caveat as favorites.

**`opentable_list_notify`** — readonly
- Calls: `GET /api/v2/users/me/notifications`.
- Returns: array of `{ notify_id, restaurant_id, restaurant_name, date, party_size, time_window? }`.

**`opentable_add_notify`** — not readonly
- Inputs: `restaurant_id: string`, `date: string`, `party_size: number`, `time_window?: string` (e.g. `"19:00-21:00"`).
- Calls: `POST /api/v2/notifications` with JSON body.
- Returns: `{ notify_id, restaurant_id, date, party_size, time_window? }`.

**`opentable_remove_notify`** — not readonly
- Inputs: `notify_id: string`.
- Calls: `DELETE /api/v2/notifications/{notify_id}`.
- Returns: `{ removed: true, notify_id }`.

## Data flow

```
Claude
  │  tool call (opentable_*)
  ▼
registerXTools (src/tools/*.ts)
  │  validate input via zod
  ▼
OpenTableClient.request(method, path, body?)
  │  ensureAuthenticated() — login if cookie jar empty
  │  fetch with spoof headers + current Cookie: ...
  │  parse any Set-Cookie into jar
  │  on 401/419 → clear jar, re-login, retry
  │  on 429 → sleep 2s, retry
  │  on 403 captcha → specific throw
  ▼
OpenTable API (www.opentable.com)
```

`opentable_book` is the only tool that issues multiple requests per invocation. Everything else is one-to-one.

## Error handling summary

| Condition | Behaviour |
| --- | --- |
| Missing `OPENTABLE_EMAIL` / `OPENTABLE_PASSWORD` | Throw on first request naming the missing var(s). |
| Login endpoint fails | Throw `"OpenTable login failed: {status} {statusText}: {body-slice}"`. |
| 401 / 419 on API call | Clear jar, re-login once, retry; on second failure throw session-rejected message. |
| 500 + auth-like body | Treat as auth failure. |
| 429 | Sleep 2000 ms, retry once; on second failure throw rate-limit message. |
| 403 + captcha/bot body | Throw bot-detection message. |
| No slots available (book) | Throw `"No available slots for this restaurant/date/party size."`. |
| MFA required on login | Throw `"OpenTable login requires MFA — unsupported in v1. Disable MFA on your account or use an app-specific credential."`. |
| Other non-2xx | Throw `"OpenTable API error: {status} {statusText} for {method} {path}"`. |

## Testing

- **TDD discipline:** write failing test → implement → green. `vitest` with `vi.fn()`-mocked `fetch`.
- **Client tests (`tests/client.test.ts`):**
  - Login happy path — sets cookie jar from `Set-Cookie`.
  - Cookie parsing — single, multiple, `max-age=0` deletion, scoped emission.
  - Happy-path request — includes spoof headers + `Cookie`.
  - 401 triggers re-login + retry, retry succeeds.
  - 401 twice in a row throws session-rejected.
  - 429 triggers 2000 ms sleep + retry.
  - 500 with `/unauthorized|auth|session/i` body treated as auth failure.
  - 403 with `/captcha|bot|challenge/i` body throws bot-detection message.
  - Two concurrent requests from an unauthenticated client call login once (simple in-flight promise guard).
- **Tool tests (`tests/tools/<name>.test.ts`):** 1:1 mirror of `src/tools/`. For each tool: happy path + zod input-validation error + at least one API-error mapping. Mock `OpenTableClient.request` rather than `fetch` where shape is simpler.
- **In-memory MCP harness (`tests/helpers.ts`):** copied from resy-mcp — `createTestHarness(registerFn)` returning `{ callTool, listTools, close }`.
- **Coverage target:** ≥ 80% lines on `client.ts` and each `tools/*.ts`.
- **Smoke script (`scripts/smoke.ts`, output gitignored):** runs one read-only probe per tool against live OpenTable with `.env` creds; prints pass/fail per probe. Used once before release to pin down candidate endpoints and confirm favorites/notify paths. Not part of CI.

## Build & packaging

- `npm run build` → `tsc --noEmit` (typecheck) then `esbuild src/index.ts --bundle --platform=node --format=esm --external:dotenv --outfile=dist/bundle.js`.
- `manifest.json` `entry_point` and `mcp_config.command` point at `dist/bundle.js`.
- `package.json` `bin.opentable-mcp = "dist/bundle.js"`.
- `.gitignore`: `node_modules/`, `dist/`, `coverage/`, `.env`, `*.mcpb`, `*.skill`.
- `.env.example`: `OPENTABLE_EMAIL`, `OPENTABLE_PASSWORD`.
- `README.md` — install, credentials, local dev, build, tests, smoke; same tone as `resy-mcp/README.md`.
- `CLAUDE.md` — terse notes (build cmd, test cmd, where to add tools, known unknowns).

## Continuous integration (GitHub Actions)

Three workflows, copied verbatim from `resy-mcp/.github/workflows/` with the string replacement `resy-mcp → opentable-mcp` (and `RESY_ → OPENTABLE_` where it applies to step names / env):

**`.github/workflows/ci.yml`**
- Triggers: `push` to `main`, all `pull_request`, reusable via `workflow_call`.
- Ubuntu latest, Node 22, `npm ci && npm run build && npm test`.

**`.github/workflows/release.yml`**
- Trigger: push of `v*` tag.
- `jobs.ci: uses: ./.github/workflows/ci.yml` to run tests first.
- `jobs.release`:
  - Checkout, `setup-node` 24 with `registry-url: https://registry.npmjs.org`.
  - Strip deprecated `always-auth` from the generated `.npmrc`.
  - `npm ci && npm run build`.
  - Extract version from `package.json` into `$VERSION`.
  - Optional: package `SKILL.md` into `opentable-mcp-${VERSION}.skill` if `SKILL.md` exists; otherwise skip.
  - Sync `manifest.json` version from `package.json`, run `npx @anthropic-ai/mcpb pack`, rename to `opentable-mcp-${VERSION}.mcpb`.
  - `npm publish --access public --provenance`.
  - `softprops/action-gh-release@v3.0.0` attaches `.mcpb` (and `.skill` if present), `generate_release_notes: true`.
- Requires npm-registry `id-token: write` permission (OIDC provenance) and `contents: write` for the GitHub Release.

**`.github/workflows/tag-and-bump.yml`**
- Trigger: `workflow_dispatch` (manual).
- `jobs.ci: uses: ./.github/workflows/ci.yml`.
- `jobs.tag-and-bump`:
  - Checkout with `${{ secrets.RELEASE_PAT }}` (the default `GITHUB_TOKEN` can't push tags that re-trigger other workflows).
  - Tag current commit with current `package.json` version (`v${CURRENT}`).
  - `npm version patch --no-git-tag-version`; propagate new version to `src/index.ts` (the `new McpServer({ name, version })` literal) and `manifest.json`.
  - Rebuild.
  - Commit `chore: bump version to v${NEXT}` and push both the new commit and the old-version tag.

### Required secrets

- `RELEASE_PAT` — GitHub PAT with `repo` scope, used only by `tag-and-bump.yml` so pushed tags trigger `release.yml`. (The default `GITHUB_TOKEN` cannot push in a way that retriggers other workflows.)
- **npm auth** — `release.yml` publishes via OIDC trusted publishing (`permissions: id-token: write` + `--provenance`). If the `@<scope>/opentable-mcp` package is configured as a trusted publisher on npmjs.com, no extra secret is needed. Otherwise set `NPM_TOKEN` as a repo secret and add `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the `npm publish` step.

## Open questions deferred to implementation

1. **Login endpoint path + request shape** — JSON vs form-encoded body, exact URL (`/authenticate/api/login` vs `/api/v2/users/login` vs `/dtp/eatery/login`), and the exact session cookie name set on success.
2. **CSRF token requirement** — does OpenTable require `x-csrf-token` on writes? If yes, where is it sourced from? (Resolved on first smoke run.)
3. **Search endpoint** — GraphQL operation name + query body, or REST `GET /dtp/eatery/search` with query params. (Capture via browser devtools on opentable.com during implementation.)
4. **Availability endpoint** — URL and param shape for `find_slots`.
5. **Book endpoint** — URL and whether a separate book-token / reservation-token intermediate step is required (analogous to resy's `book_token`).
6. **Favorites endpoint paths** — verify list / add / remove (`GET/POST/DELETE /api/v2/users/me/favorites` is the candidate; may be under `/api/v2/me/` or elsewhere).
7. **Notify endpoint paths** — verify list / add / remove; confirm payload shape for `time_window`.
8. **List-reservations scope** — confirm whether a `scope` query param is honoured API-side or whether we must filter client-side by date.
9. **Profile endpoint** — confirm `GET /api/v2/users/me` vs alternates; confirm the field names we select in the returned profile.

Each resolves inline during implementation via the smoke script. Falsified assumptions adjust URL / body / headers only, not scope. If any probe can't be resolved (e.g., bot-detection blocks smoke runs entirely), re-open the scope decision with the user before working around it.
