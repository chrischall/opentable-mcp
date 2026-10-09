# opentable-mcp

[![CI](https://github.com/chrischall/opentable-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/opentable-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opentable-mcp)](https://www.npmjs.com/package/opentable-mcp)
[![license](https://img.shields.io/npm/l/opentable-mcp)](LICENSE)

OpenTable reservation manager as an MCP server for Claude — find slots, book, cancel, manage favorites, and read your dashboard via natural language.

> **v0.3.0-alpha status: Chrome-extension bridge, 10 tools, read + write.** Every OpenTable request is relayed through your signed-in Chrome tab over a localhost WebSocket — each request rides your existing session and reaches OpenTable as if you'd clicked it yourself.

## How it works

OpenTable's edge (Akamai Bot Manager) enforces a behavioral challenge on `/`, `/s`, `/r/…`, `/dapi/…`, and `/booking/…`. Tooling that builds its own HTTP client — cycletls, impersonated curl, headless Chrome — invents a separate identity and gets a 403 or JS interstitial. opentable-mcp does the opposite: it uses your own browser session as-is, with the cookies and TLS context it already has.

So instead of standing in for the browser, this MCP server:

1. Starts a WebSocket listener on `127.0.0.1:37149` via [`@fetchproxy/server`](https://github.com/chrischall/fetchproxy).
2. The [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge/releases) browser extension (installed once, shared across all fetchproxy-based MCPs) connects from your signed-in browser and relays every request through the opentable.com tab via `fetch(..., { credentials: 'include' })` — your TLS, your cookies, your already-solved `_abck`.
3. Parses JSON responses (public GraphQL / JSON endpoints) and SSR HTML (`/user/*`) into tool-shaped output.

No cookie-pasting. No cycletls. No Playwright. Just your own browser, acting on its own behalf — the MCP server only picks what to ask for.

## Tools

| Tool | Kind | Source |
| --- | --- | --- |
| `opentable_list_reservations` | read | `/user/dining-dashboard` SSR |
| `opentable_get_profile` | read | `/user/dining-dashboard` SSR |
| `opentable_list_favorites` | read | `/user/favorites` SSR |
| `opentable_search_restaurants` | read | `/dapi/fe/gql?opname=Autocomplete` |
| `opentable_get_restaurant` | read | `/r/{slug}` SSR (`__INITIAL_STATE__`) |
| `opentable_get_menu` | read | Restaurant profile SSR (`restaurantProfile.menus`) |
| `opentable_find_slots` | read | `/dapi/fe/gql?opname=RestaurantsAvailability` |
| `opentable_book_preview` | read | `/booking/details` SSR + `SlotLock` |
| `opentable_book` | write | `SlotLock` → `/dapi/booking/make-reservation` |
| `opentable_cancel` | write | `/dapi/fe/gql?opname=CancelReservation` |
| `opentable_modify_preview` | read | `/booking/details` SSR (`isModify=true`) + `SlotLock` |
| `opentable_modify` | write | `/dapi/booking/make-reservation` (`isModify: true`) |
| `opentable_add_favorite` | write | `/dapi/wishlist/add` |
| `opentable_remove_favorite` | write | `/dapi/wishlist/remove` |
| `opentable_healthcheck` | read | `/robots.txt` (bridge probe) |

### Published menus

`opentable_get_menu` accepts the same restaurant ID, slug, path, or exact URL
as `opentable_get_restaurant`. Omit `menu_name` to return all published menus,
or pass an exact title such as `"Dinner"` (case-insensitive) to select one:

```json
{"restaurant_id":"https://www.opentable.com/r/social-san-juan","menu_name":"Dinner"}
```

The response includes restaurant identity and source `url`, `available_menus`,
`menus`, and an optional external `menu_url`. Each published menu retains
OpenTable's sections/items, price strings, `variationGroups`, currency,
provider, and `updated` timestamp. `view` defaults to `compact` (media URLs
removed); `full` retains media URLs too. Published prices may differ from the
restaurant's current menu, so keep the source and update timestamp when quoting.

Large menus come back as pages of whole items, so a reply never stops halfway
through a dish. Without paging arguments a menu that fits is returned as-is;
a larger one returns its first page. Each page carries `available_sections` and
`pagination`:

```json
{"offset":0,"returned_items":20,"total_items":57,"next_offset":20}
```

To continue, call again with `offset` set to `next_offset` and the same
`menu_name`/`section_name`; `next_offset` is `null` on the last page. Optional
paging inputs:

- `section_name` — an exact section title (case-insensitive); the reply adds
  `section_found`.
- `offset` — the item to start from (default `0`).
- `limit` — at most this many items per page (1–50, default 20). A page may
  return fewer to stay within the response budget.

`view: "full"` with no paging inputs returns the whole menu uncapped, for
clients without an output limit. A single item too large for a page is an
error, never a truncated description.

`status` distinguishes `available`, `menu_not_found` (check `available_menus`),
`external_only`, and `not_available`. An absent menu is not an HTTP/bridge or
parsing error: those failures remain errors. External links are returned
without fetching other hosts or parsing PDFs. This tool only reads the same
restaurant page through the existing browser bridge; it never holds a table.

## Acknowledgement of Terms

By using this MCP server, you acknowledge and agree to the following:

**1. This server accesses your own OpenTable account.** Every request is dispatched through your own signed-in browser tab via the ContextMint Bridge browser extension (or hangwin/mcp-chrome). It does not — and cannot — access anyone else's reservations.

**2. [OpenTable's Terms of Use](https://www.opentable.com/c/legal/terms-and-conditions/) govern your use of this server**, just as they govern your direct use of opentable.com. The clauses most relevant here:

> You may not use any deep-link, robot, spider, scraper, generative AI or other AI technology including, but not limited to, those that operate by interacting with or otherwise making use of your browser, such as automated assistants or other automatic or manual device, process, or means to access, copy, search, or monitor any portion of the Services or OpenTable Content, except as expressly authorized by OpenTable.

And, critically: *"Actions of AI agents are acknowledged as actions of the User that is using them, and the User is responsible for checking and verifying the action…"*

You are agreeing to those terms — read by the maintainer 2026-05-23 — every time you invoke a tool in this server. OpenTable's ToU explicitly enumerates AI/automated-assistant access among the things they have not authorized; they also explicitly impute AI-agent actions back to you.

**3. Personal, non-commercial use only.** This project is not affiliated with, endorsed by, sponsored by, or in partnership with OpenTable, Inc. It is a personal automation tool that drives the same `/dapi/...` and `/booking/...` endpoints opentable.com uses. Do not use it to mass-book, sweep CC-required tables, resell reservations, or for any commercial purpose. The book/cancel/modify tools exist so you can manage one reservation as if you were sitting at your browser.

**4. Stability is not guaranteed.** This server depends on internal OpenTable persisted-GraphQL query hashes that OpenTable rotates between deployments. When they rotate, tools break and we re-capture them. Your own use is at the mercy of OpenTable's release cadence.

**5. You accept full responsibility** for any consequences of using this server in connection with your OpenTable account — rate limiting, slot-lock rejections, no-show penalties for runaway bookings, account warnings, suspension, or any enforcement action. **Per OpenTable's ToU, the AI agent's actions are your actions** — review every book/cancel before you confirm. If OpenTable objects to your use, stop using this server.

This section is the maintainer's good-faith summary of the terms — it is not legal advice and does not modify or supersede OpenTable's actual ToU.

## Install

```bash
npm install
npm run build
```

### Install ContextMint Bridge

opentable-mcp shares one browser extension, **ContextMint Bridge**, with every other fetchproxy-based MCP. Install it once from https://github.com/nullnet-app/contextmint-bridge/releases:

ContextMint Bridge is the fetchproxy browser extension under its new name, from the same maintainer — fetchproxy's own README (https://github.com/chrischall/fetchproxy#extension) points to it. Its source is public at https://github.com/nullnet-app/contextmint-bridge: build it yourself, or check a release zip against the `.sha256` file published beside it (`shasum -a 256 -c contextmint-bridge-chrome-<version>.zip.sha256`).

1. **Chrome:** download the Chrome zip from the latest release, unzip it, and load it unpacked (`chrome://extensions` → Developer mode → Load unpacked). Safari isn't available yet — it will ship inside the ContextMint app, which has no public download — so use Chrome for now.
2. Sign in to `https://www.opentable.com/` in that same browser profile.
3. The extension badge shows a green dot when the WebSocket + tab + auth cookie are all detected.

After that, any MCP client that launches `node dist/bundle.js` will reach OpenTable through your signed-in tab.

**Full setup + troubleshooting guide:** see the [ContextMint Bridge repo](https://github.com/nullnet-app/contextmint-bridge) for the status-dot reference, WS protocol, and request lifecycle. Persisted-query hash capture for OpenTable redeploys is documented in [`CLAUDE.md`](CLAUDE.md) here.

## Configure (Claude Desktop / Claude Code)

```json
{
  "mcpServers": {
    "opentable": {
      "command": "node",
      "args": ["/absolute/path/to/opentable-mcp/dist/bundle.js"]
    }
  }
}
```

No env vars required by default — auth lives in the browser, not the MCP process.

### Optional: bridge through hangwin/mcp-chrome instead

If you've installed [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) for browser automation, opentable-mcp can route its OpenTable fetches through it instead of ContextMint Bridge:

```json
{
  "mcpServers": {
    "opentable": {
      "command": "node",
      "args": ["/absolute/path/to/opentable-mcp/dist/bundle.js"],
      "env": { "OT_BRIDGE": "mcp-chrome" }
    }
  }
}
```

In that mode you don't need ContextMint Bridge. Every OpenTable request becomes a `chrome_network_request` call against your existing mcp-chrome install, pinned via `tabUrl` to an opentable.com tab.

**This mode is read-only.** Booking, modifying, cancelling and favorites are refused with a clear error — OpenTable's write endpoints need a CSRF token from a restaurant/booking/account page, which this transport can't supply — and `opentable_find_slots` is unavailable. Use the default ContextMint Bridge transport for those.

**Note:** this path requires mcp-chrome ≥ the release containing [PR #348](https://github.com/hangwin/mcp-chrome/pull/348) (`tabUrl` parameter on `chrome_network_request`). Pre-#348 mcp-chrome versions are active-tab-only and will misbehave for cross-origin fetches. Live-verification of this path is pending the upstream merge.

Other env vars: `OT_WS_PORT` (default 37149) overrides the fetchproxy WebSocket port; `OT_MCP_CHROME_URL` (default `http://127.0.0.1:12306/mcp`) overrides the mcp-chrome endpoint.

## Confirmations

`opentable_book`, `opentable_modify` and `opentable_cancel` ask you before they act. A client that can show a confirmation prompt (Claude Code) shows one. On a client that cannot (claude.ai, Claude Desktop), the first call books, changes or cancels nothing: it returns a preview of exactly what would happen plus a `confirmToken`. Either way the prompt names the restaurant, date, time and party size, and for a booking or change the card that will be held and the cancellation policy (carried in the `booking_token` / `modify_token` from the preview tools; a cancel looks the reservation up on your dining dashboard and warns if it isn't there). Only a repeat call with the same arguments and that token proceeds, once — change any argument in between and it is refused (`DRAFT_CHANGED`) with a fresh preview.

| variable | default | |
|---|---|---|
| `MCP_CONFIRM_MODE` | `ask-user` | What a write does on a client that cannot show a confirmation prompt (claude.ai, Claude Desktop). `ask-user`: two steps — the first call does nothing and returns a preview plus a token, and the model must get your approval in chat before calling again with it. `auto`: the same two steps, but the model may use the token after reviewing the preview itself. `refuse`: writes are refused on such clients. A client that can show prompts (Claude Code) always gets the real prompt, unless `MCP_CONFIRM_ELICITATION=off`. An unrecognised value is treated as `refuse`. |
| `MCP_CONFIRM_ELICITATION` | `on` | `off` never shows a confirmation prompt, so every client gets the `MCP_CONFIRM_MODE` behaviour. Set it for a client that says it can show prompts but never does (the write hangs — opencode 2.0.x). Any other value is treated as `on`, with a warning on stderr. |
| `MCP_CONFIRM_TTL_SECONDS` | `600` | How long a token stays valid. |
| `MCP_CONFIRM_SECRET` | random per process | Signing key; set it only if tokens must survive a server restart. On mcp-host the host supplies a stable per-child key (`MCP_HOST_CONFIRM_SECRET`) and spent tokens are recorded under `MCP_DATA_DIR`, so an approval survives an idle restart. |

## Run (local stdio)

```bash
node dist/bundle.js
```

## Test

```bash
npm test                              # vitest, 72 unit tests, mocked fetch
npm run build                         # tsc + esbuild bundle
npx tsx scripts/probe-find-slots.ts   # live GET round-trip via extension
npx tsx scripts/probe-list-res.ts     # live dashboard SSR
```

The `scripts/probe-*.ts` files spin up the MCP server, call one or two tools through the extension bridge, and print the response. They require the extension to be loaded and an opentable tab to be open.

## Troubleshooting

- **Red dot in popup / "extension offline" errors.** See ContextMint Bridge's troubleshooting guide — most "extension offline" issues are upstream lifecycle bugs (service-worker sleep, dead content script), not opentable-mcp.
- **Behavioral challenge page in Chrome.** Akamai sometimes interrupts a long-idle tab with a "verify you're human" interstitial. Click through it once and the tab is usable again.
- **`list_favorites` doesn't reflect a fresh `add_favorite`.** The `/user/favorites` SSR page is cached for a few seconds. Re-list after ~10 s or verify via `opentable_get_profile`'s count.

## Layout

- `src/transport-fetchproxy.ts` — `FetchproxyTransport`: thin adapter over `@fetchproxy/server`'s `FetchproxyServer`, the shared WebSocket bridge that talks to the ContextMint Bridge browser extension.
- `src/client.ts` — `OpenTableClient`: wraps the transport with `fetchJson` / `fetchHtml` + error-mapping.
- `src/tools/*.ts` — one file per concern (reservations / restaurants / favorites / user / search). Each exports `registerXxxTools(server, client)`.
- `src/parse-*.ts` — pure HTML/JSON parsers, fully unit-tested.
- `tests/` — 1:1 mirror of `src/`, vitest. WS-protocol-level tests live upstream in the fetchproxy repo.
- `scripts/probe-*.ts` — live round-trip probes (require ContextMint Bridge + sign-in).

## Known quirks

- **Apollo persisted queries.** Slot search, slot lock, cancel, autocomplete — all use `extensions.persistedQuery.sha256Hash` with hashes captured from opentable.com. If OpenTable re-deploys, the server returns `PersistedQueryNotFound`; see `CLAUDE.md` → "Hot spots" for the re-capture procedure.
- **`dining_area_id` is a required book arg.** We can't auto-resolve rooms, so pass the restaurant's slug **or numeric id** to `opentable_get_restaurant` (slugs route to `/r/{slug}`, numeric ids to `/restaurant/profile/{id}`), read `diningAreas[]`, and feed the id into `opentable_book`.
- **Service-worker sleep.** MV3 SWs sleep after ~30 s idle. ContextMint Bridge keeps itself warm; on cold wake, the first request may wait up to ~5 s for WS reconnect.

---

This project was developed and is maintained by AI (Claude Opus 4.7).
