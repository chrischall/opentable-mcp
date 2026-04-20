# opentable-mcp

OpenTable reservation manager as an MCP server for Claude — find slots, book, cancel, manage favorites, and read your dashboard via natural language.

> **v0.3.0-alpha status: Chrome-extension bridge, 10 tools, read + write.** Every OpenTable request is relayed through your signed-in Chrome tab over a localhost WebSocket, so Akamai sees a real browser and we get clean 200s on paths that block Node `fetch` entirely.

## How it works

OpenTable's edge (Akamai Bot Manager) serves a behavioral challenge to non-browser HTTP clients on `/`, `/s`, `/r/…`, `/dapi/…`, and `/booking/…`. cycletls, impersonated curl, and headless Chrome all hit 403 or a JS interstitial. The only thing Akamai never blocks is the actual signed-in Chrome tab.

So instead of shipping another bot-evasion dance, this MCP server:

1. Starts a WebSocket listener on `127.0.0.1:37149`.
2. A companion Chrome extension (`./extension/`) connects from your signed-in browser and relays every request through the opentable.com tab via `fetch(..., { credentials: 'include' })` — real TLS, real cookies, real challenge-solved `_abck`.
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

### Load the Chrome extension

1. Open `chrome://extensions`, enable Developer Mode.
2. Click **Load unpacked** and select `./extension/` from this repo.
3. Sign in to `https://www.opentable.com/` in that same Chrome profile.
4. The extension badge shows a green dot when the WebSocket + tab + auth cookie are all detected.

After that, any MCP client that launches `node dist/bundle.js` will reach OpenTable through your signed-in tab.

**Full setup + troubleshooting guide:** [`extension/README.md`](extension/README.md) covers the status-dot reference, WS protocol, request lifecycle, and how to capture new persisted-query hashes when OpenTable redeploys.

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

No env vars required — auth lives in the browser, not the MCP process.

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

- **Red dot in popup / "extension offline" errors.** Click the popup's Reconnect button, or reload the extension at `chrome://extensions`. The extension auto-reinjects content scripts into any existing opentable tab on reload.
- **"Could not establish connection. Receiving end does not exist."** First call after an extension reload — the fallback path reinjects the content script and retries. If it persists, hard-reload the opentable tab (Cmd-Shift-R).
- **Behavioral challenge page in Chrome.** Akamai sometimes interrupts a long-idle tab with a "verify you're human" interstitial. Click through it once and the tab is usable again.
- **`list_favorites` doesn't reflect a fresh `add_favorite`.** The `/user/favorites` SSR page is cached for a few seconds. Re-list after ~10 s or verify via `opentable_get_profile`'s count.

## Layout

- `src/ws-server.ts` — `OpenTableWsServer`: accepts the extension WS, relays `fetch` RPCs.
- `src/client.ts` — `OpenTableClient`: wraps the WS with `fetchJson` / `fetchHtml` + error-mapping.
- `src/tools/*.ts` — one file per concern (reservations / restaurants / favorites / user / search). Each exports `registerXxxTools(server, client)`.
- `src/parse-*.ts` — pure HTML/JSON parsers, fully unit-tested.
- `extension/` — MV3 service worker, content script (fetch relay, isolated world), capture logger (MAIN world).
- `tests/` — 1:1 mirror of `src/`, vitest.
- `scripts/probe-*.ts` — live round-trip probes (require extension + sign-in).

## Known quirks

- **Apollo persisted queries.** Slot search, slot lock, cancel, autocomplete — all use `extensions.persistedQuery.sha256Hash` with hashes captured from opentable.com. If OpenTable re-deploys, the server returns `PersistedQueryNotFound`; open the extension's capture log to re-grab them.
- **`dining_area_id` is a required book arg.** `/r/<numeric-id>` 404s on OpenTable (URLs use slugs), so we can't auto-resolve rooms. Pass the restaurant's URL slug to `opentable_get_restaurant`, read `diningAreas[]`, and feed the id into `opentable_book`.
- **Service worker sleep.** MV3 SWs sleep after ~30 s idle. The extension holds a 20 s ping + a 25 s `chrome.alarms` tick to stay warm. On cold wake, the first request may wait up to ~5 s for WS reconnect.

---

This project was developed and is maintained by AI (Claude Opus 4.7).
