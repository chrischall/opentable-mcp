---
name: opentable-mcp
description: Manage OpenTable reservations via MCP — search restaurants, check slot availability, book tables, list/cancel reservations, and manage favorites. Triggers on phrases like "book a table on OpenTable", "find me a reservation at", "what OpenTable reservations do I have", "cancel my OpenTable", "add to my OpenTable favorites", "what's available for dinner tonight at", or any request involving OpenTable restaurant reservations. Requires opentable-mcp installed and the companion Chrome extension running in a signed-in opentable.com tab.
---

# opentable-mcp

MCP server for OpenTable — natural-language restaurant reservation management. Every request is relayed through the user's signed-in Chrome tab via a companion extension, so there's no cookie paste, no bot-wall dance, and no password handling.

- **npm:** [npmjs.com/package/opentable-mcp](https://www.npmjs.com/package/opentable-mcp)
- **Source:** [github.com/chrischall/opentable-mcp](https://github.com/chrischall/opentable-mcp)

> OpenTable does not publish an official API. This server calls the same endpoints the opentable.com web app uses. Auth lives in the user's browser (OpenTable's passwordless email-OTP session). Use at your own discretion.

## Setup

The MCP server is half of the picture — the other half is a Chrome companion extension that actually talks to OpenTable from your signed-in tab. Both are required.

### 1. Install the MCP server

#### Option A — npx (recommended)

Add to `.mcp.json` in your project or `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "opentable": {
      "command": "npx",
      "args": ["-y", "opentable-mcp"]
    }
  }
}
```

#### Option B — from source

```bash
git clone https://github.com/chrischall/opentable-mcp
cd opentable-mcp
npm install && npm run build
```

Then add to `.mcp.json`:

```json
{
  "mcpServers": {
    "opentable": {
      "command": "node",
      "args": ["/path/to/opentable-mcp/dist/bundle.js"]
    }
  }
}
```

### 2. Install the Chrome extension

1. Clone the repo (Option B above does this).
2. Open `chrome://extensions`, enable Developer Mode.
3. Click **Load unpacked**, select the `extension/` folder.
4. Sign in to `https://www.opentable.com/` in the same Chrome profile.

The extension's toolbar badge turns green when the WebSocket + tab + auth are all good.

Full extension walkthrough: [`extension/README.md`](https://github.com/chrischall/opentable-mcp/tree/main/extension).

## Authentication

No env vars. Auth is whatever cookies your signed-in opentable.com tab has. If Akamai rotates `_abck` or OpenTable's SSO expires, visit opentable.com and click through whatever prompt appears — subsequent MCP calls will use the fresh cookies automatically.

The server throws `SessionNotAuthenticatedError` (with a clear message) if it detects the sign-in interstitial.

## Tools

### Discovery
| Tool | Description |
|------|-------------|
| `opentable_search_restaurants(term?, location?, date?, time?, party_size?, latitude?, longitude?, metro_id?)` | Search by free-text + optional location / date / party size. Returns cuisine, neighborhood, price band, rating, URL slug. No bookable slots — call `find_slots` for those. |
| `opentable_get_restaurant(restaurant_id)` | Full detail for one restaurant by URL slug (e.g. `"state-of-confusion-charlotte"`). Includes `diningAreas[]` — you need one of their ids to book. **Numeric ids 404 here; always pass the slug.** |
| `opentable_find_slots(restaurant_id, date, time, party_size)` | List bookable slots for a restaurant on a date + party size. Each slot has a short-lived `reservation_token` + `slot_hash` (book within a minute or two of fetching). |

### User
| Tool | Description |
|------|-------------|
| `opentable_list_reservations(scope?)` | List reservations. `scope`: `upcoming` (default), `past`, `all`. Each entry has the `confirmation_number` + `security_token` needed to cancel. |
| `opentable_get_profile` | Authenticated user's profile: name, email, phones, loyalty points, home metro, member-since. No payment data. |

### Bookings
| Tool | Description |
|------|-------------|
| `opentable_book(restaurant_id, date, time, party_size, reservation_token, slot_hash, dining_area_id)` | Book a slot. Requires fresh `reservation_token` + `slot_hash` from `find_slots` and `dining_area_id` from `get_restaurant`. Auto-fetches the user's profile for the booking payload. Returns `confirmation_number` + `security_token` (save both — they're required for cancel). |
| `opentable_cancel(restaurant_id, confirmation_number, security_token)` | Cancel by the triple returned from `book` or `list_reservations`. |

### Favorites
| Tool | Description |
|------|-------------|
| `opentable_list_favorites` | List saved restaurants. |
| `opentable_add_favorite(restaurant_id)` | Add a restaurant (numeric id) to Saved Restaurants. |
| `opentable_remove_favorite(restaurant_id)` | Remove from Saved Restaurants. |

## Workflows

**Book a specific restaurant for a specific evening:**
```
opentable_search_restaurants(term: "state of confusion", location: "Charlotte")
  → note the restaurant_id (numeric) + URL slug
opentable_get_restaurant(restaurant_id: "state-of-confusion-charlotte")
  → pick dining_area_id from diningAreas[]
opentable_find_slots(restaurant_id, date: "2026-05-01", time: "19:00", party_size: 2)
  → pick a slot, grab reservation_token + slot_hash
opentable_book(restaurant_id, date, time, party_size, reservation_token, slot_hash, dining_area_id)
  → save confirmation_number + security_token
```

**"What's available tonight for 2 at a nice Italian spot?":**
```
opentable_search_restaurants(term: "italian", date: "2026-04-20", time: "19:00", party_size: 2, latitude: <lat>, longitude: <lng>)
  → scan results, pick candidates
opentable_find_slots(restaurant_id, date, time, party_size)  # for each candidate
```

**Cancel an upcoming reservation:**
```
opentable_list_reservations(scope: "upcoming")
  → find the one to cancel, read confirmation_number + security_token
opentable_cancel(restaurant_id, confirmation_number, security_token)
```

**Save a restaurant for later:**
```
opentable_search_restaurants(term: "carbone")
  → pick the restaurant_id
opentable_add_favorite(restaurant_id)
```

## Notes

- **Slot tokens are short-lived.** `reservation_token` + `slot_hash` from `find_slots` typically expire within a minute or two. Call `find_slots` just before `book`, and if the user is deliberating, re-fetch.
- **`dining_area_id` is mandatory for book.** OpenTable's `/r/<numeric-id>` routes 404 — there's no way to auto-resolve the default dining room. Always call `opentable_get_restaurant(slug)` first and pick a room from `diningAreas[]`.
- **`/user/favorites` has a read-after-write lag.** A fresh `add_favorite` may not show up in `list_favorites` for ~10 s. The 204 response from add/remove is authoritative.
- **Extension must be running.** If the MCP server throws "opentable-mcp extension offline", the user needs to: load the extension at `chrome://extensions`, open an opentable.com tab, and sign in. The popup has a green/yellow/red status indicator.
- **Service worker sleep.** Chrome MV3 SWs sleep after ~30 s idle. Cold wake adds ~2-5 s to the first request. Subsequent calls are fast.
- **Persisted-query hashes.** `find_slots`, `book`, `cancel`, and `search` use Apollo persisted queries pinned by sha256Hash. If OpenTable redeploys and returns `PersistedQueryNotFound`, re-capture via the extension's XHR logger (see `extension/README.md`).
