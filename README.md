# opentable-mcp

OpenTable reservation manager as an MCP server for Claude — find slots, book, cancel, manage favorites, and read your dashboard via natural language.

> **v0.3.0-alpha status: Chrome-extension bridge, 10 tools, read + write.** Every OpenTable request is relayed through your signed-in Chrome tab over a localhost WebSocket, so Akamai sees a real browser and we get clean 200s on paths that block Node `fetch` entirely.

## How it works

OpenTable's edge (Akamai Bot Manager) serves a behavioral challenge to non-browser HTTP clients on `/`, `/s`, `/r/…`, `/dapi/…`, and `/booking/…`. cycletls, impersonated curl, and headless Chrome all hit 403 or a JS interstitial. The only thing Akamai never blocks is the actual signed-in Chrome tab.

So instead of shipping another bot-evasion dance, this MCP server:

1. Starts a WebSocket listener on `127.0.0.1:37149` via [`@fetchproxy/server`](https://github.com/chrischall/fetchproxy).
2. The [fetchproxy browser extension](https://github.com/chrischall/fetchproxy) (installed once, shared across all fetchproxy-based MCPs) connects from your signed-in browser and relays every request through the opentable.com tab via `fetch(..., { credentials: 'include' })` — real TLS, real cookies, real challenge-solved `_abck`.
3. Parses JSON responses (public GraphQL / JSON endpoints) and SSR HTML (`/user/*`) into tool-shaped output.

No cookie-pasting. No cycletls. No Playwright.

## Tools

| Tool | Kind | Source |
| --- | --- | --- |
| `opentable_list_reservations` | read | `/user/dining-dashboard` SSR |
| `opentable_get_profile` | read | `/user/dining-dashboard` SSR |
| `opentable_list_favorites` | read | `/user/favorites` SSR |
| `opentable_search_restaurants` | read | `/dapi/fe/gql?opname=Autocomplete` |
| `opentable_get_restaurant` | read | `/r/{slug}` SSR (`__INITIAL_STATE__`) |
| `opentable_find_slots` | read | `/dapi/fe/gql?opname=RestaurantsAvailability` |
| `opentable_book` | write | `SlotLock` → `/dapi/booking/make-reservation` |
| `opentable_cancel` | write | `/dapi/fe/gql?opname=CancelReservation` |
| `opentable_add_favorite` | write | `/dapi/wishlist/add` |
| `opentable_remove_favorite` | write | `/dapi/wishlist/remove` |

## Install

```bash
npm install
npm run build
```

### Install the fetchproxy extension

opentable-mcp shares one browser extension with every other fetchproxy-based MCP. Install it once from https://github.com/chrischall/fetchproxy:

1. Install the fetchproxy extension (Chrome Web Store / Safari `.dmg`).
2. Sign in to `https://www.opentable.com/` in that same browser profile.
3. The extension badge shows a green dot when the WebSocket + tab + auth cookie are all detected.

After that, any MCP client that launches `node dist/bundle.js` will reach OpenTable through your signed-in tab.

**Full setup + troubleshooting guide:** see the fetchproxy repo for the status-dot reference, WS protocol, and request lifecycle. Persisted-query hash capture for OpenTable redeploys is documented in [`CLAUDE.md`](CLAUDE.md) here.

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

If you've installed [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) for browser automation, opentable-mcp can route its OpenTable fetches through it instead of the fetchproxy extension:

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

In that mode you don't need the fetchproxy extension. Every OpenTable request becomes a `chrome_network_request` call against your existing mcp-chrome install, pinned via `tabUrl` to an opentable.com tab.

**Note:** this path requires mcp-chrome ≥ the release containing [PR #348](https://github.com/hangwin/mcp-chrome/pull/348) (`tabUrl` parameter on `chrome_network_request`). Pre-#348 mcp-chrome versions are active-tab-only and will misbehave for cross-origin fetches. Live-verification of this path is pending the upstream merge.

Other env vars: `OT_WS_PORT` (default 37149) overrides the fetchproxy WebSocket port; `OT_MCP_CHROME_URL` (default `http://127.0.0.1:12306/mcp`) overrides the mcp-chrome endpoint.

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

- **Red dot in popup / "extension offline" errors.** See the fetchproxy extension's troubleshooting guide — most "extension offline" issues are upstream lifecycle bugs (service-worker sleep, dead content script), not opentable-mcp.
- **Behavioral challenge page in Chrome.** Akamai sometimes interrupts a long-idle tab with a "verify you're human" interstitial. Click through it once and the tab is usable again.
- **`list_favorites` doesn't reflect a fresh `add_favorite`.** The `/user/favorites` SSR page is cached for a few seconds. Re-list after ~10 s or verify via `opentable_get_profile`'s count.

## Layout

- `src/transport-fetchproxy.ts` — `FetchproxyTransport`: thin adapter over `@fetchproxy/server`'s `FetchproxyServer`, the shared WebSocket bridge that talks to the fetchproxy browser extension.
- `src/client.ts` — `OpenTableClient`: wraps the transport with `fetchJson` / `fetchHtml` + error-mapping.
- `src/tools/*.ts` — one file per concern (reservations / restaurants / favorites / user / search). Each exports `registerXxxTools(server, client)`.
- `src/parse-*.ts` — pure HTML/JSON parsers, fully unit-tested.
- `tests/` — 1:1 mirror of `src/`, vitest. WS-protocol-level tests live upstream in the fetchproxy repo.
- `scripts/probe-*.ts` — live round-trip probes (require the fetchproxy extension + sign-in).

## Known quirks

- **Apollo persisted queries.** Slot search, slot lock, cancel, autocomplete — all use `extensions.persistedQuery.sha256Hash` with hashes captured from opentable.com. If OpenTable re-deploys, the server returns `PersistedQueryNotFound`; see `CLAUDE.md` → "Hot spots" for the re-capture procedure.
- **`dining_area_id` is a required book arg.** `/r/<numeric-id>` 404s on OpenTable (URLs use slugs), so we can't auto-resolve rooms. Pass the restaurant's URL slug to `opentable_get_restaurant`, read `diningAreas[]`, and feed the id into `opentable_book`.
- **Service-worker sleep.** MV3 SWs sleep after ~30 s idle. The fetchproxy extension keeps itself warm; on cold wake, the first request may wait up to ~5 s for WS reconnect.

---

This project was developed and is maintained by AI (Claude Opus 4.7).
