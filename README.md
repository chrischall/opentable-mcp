# opentable-mcp

OpenTable reservation reader as an MCP server for Claude — list your reservations, profile, and saved restaurants via natural language.

> **v0.2.0-alpha.3 status: partial.** Read-only, happy-path verified against a real account for `list_reservations` / `get_profile` / `list_favorites`. `search_restaurants` and `get_restaurant` parse the same SSR shape; unit-tested but not yet in-session live-verified (Akamai cookie rotation caught up with the test session — the new `npm run auth` flow resolves that). Write operations (book / cancel / favorites-CRUD) and `find_slots` are not yet implemented — see the Roadmap below.

## How it works

OpenTable is a Next.js app. Each authenticated page embeds its React state as `"__INITIAL_STATE__":{...}` in the HTML, and there is no corresponding public JSON API. This server:

1. Accepts session cookies exported from an already-logged-in Chrome tab (Akamai's `_abck` plus OpenTable's `authCke` and friends).
2. Uses [`cycletls`](https://www.npmjs.com/package/cycletls) to issue HTTPS requests with a desktop-Chrome JA3 TLS fingerprint — this is necessary because Akamai Bot Manager resets Node's default `fetch` with `HTTP/2 INTERNAL_ERROR`.
3. Fetches the relevant user page (e.g. `/user/dining-dashboard`), extracts `__INITIAL_STATE__` via a brace-balanced JSON walker, and maps the subtree for that tool into tidy JSON.

No Playwright. No headless Chromium download. No MFA/password handling.

## Tools (v0.2.0-alpha.2)

| Tool | Source page | Returns |
| --- | --- | --- |
| `opentable_list_reservations` | `/user/dining-dashboard` | Upcoming / past / all reservations with confirmation number, security token, date, time, party size, status |
| `opentable_get_profile` | `/user/dining-dashboard` | Name, email, phones, loyalty points, home metro, member-since, VIP flag |
| `opentable_list_favorites` | `/user/favorites` | Saved restaurants: id, name, cuisine, neighborhood, price band, rating, URL |
| `opentable_search_restaurants` | `/s?term=...` | Up to ~50 restaurants per query with rating, address, phone, coordinates, description, URL (no slots — see notes) |
| `opentable_get_restaurant` | `/r/{id-or-slug}` | Full restaurant details: cuisine, price, hours, features, payment options, address, phone, website, reviews summary |

## Install

```bash
npm install
npm run build
```

## Configure

OpenTable's auth is passwordless OTP (email or SMS), not email+password. Rather than automate the OTP dance, v0.2 ships a one-shot helper that launches your real Chrome, waits for you to sign in, and captures the session cookies.

### `npm run auth`

```bash
npm run auth                 # prompts → reads clipboard → writes ~/.config/opentable-mcp/cookies.txt
npm run auth -- --open       # also opens opentable.com in your default browser
npm run auth -- --print      # also prints the cookie string (for MCPB paste)
npm run auth -- .env         # instead writes OPENTABLE_COOKIES=<value> to .env
```

The script is deliberately un-automated: OpenTable's Akamai bot manager detects puppeteer-driven Chrome regardless of stealth flags (CDP + `--disable-blink-features=AutomationControlled` are tells it keys on). So the flow is:

1. Sign in to opentable.com in your **regular** Chrome (email-OTP click-through).
2. DevTools → Console → `copy(document.cookie)`.
3. Come back to the terminal and press Enter — the script reads from your clipboard, validates that it has both `authCke` and `_abck`, and writes the mode-600 file the server reads.

Why your regular Chrome works where `puppeteer` can't: Akamai passes a real-user TLS/JS fingerprint and trips a bot on anything driven via CDP. Your browser does all the handshaking; we just copy the cookies.

The cookies file is at `~/.config/opentable-mcp/cookies.txt` by default and is world-unreadable.

### Cookie sources, in order of precedence

1. `OPENTABLE_COOKIES` env var (direct, wins over file).
2. `OPENTABLE_COOKIES_PATH` env var (path to file).
3. Default: `~/.config/opentable-mcp/cookies.txt`.

For MCPB / Claude Desktop install, the manifest prompts for "OpenTable Session Cookies" at configure time and propagates them via `OPENTABLE_COOKIES`.

### Refreshing cookies

Akamai rotates `_abck` every few hours and tightens the noose when it detects unusual traffic. When the server returns `SessionExpiredError`:

1. Visit opentable.com in your normal Chrome (you'll still be signed in).
2. DevTools → Console → `copy(document.cookie)`.
3. `npm run auth` → press Enter.

Thirty seconds, no OTP round if Chrome's still authenticated.

## Run (local stdio)

```bash
node dist/bundle.js
```

## Test

```bash
npm test                                     # unit tests (mocked fetch)
OPENTABLE_COOKIES_PATH=/tmp/ot-cookies.txt \
  npx tsx scripts/e2e-list-reservations.ts   # live dashboard round-trip
```

## Roadmap

- **Phase 2 (done, this release)** — `opentable_search_restaurants`, `opentable_get_restaurant`. Each fetches its own SSR page and parses the relevant subtree of `__INITIAL_STATE__`.
- **Deferred: `opentable_find_slots`.** OpenTable does NOT include slot availability in server-rendered HTML — the restaurant page hydrates first, then fires a `RestaurantsAvailability` GraphQL POST to `/dapi/fe/gql` for slots. Building this tool requires capturing that query's body (it's not in URL params) and replaying it via cycletls. The work is mechanical but needs a fresh live cookie window.
- **Phase 3 (not started)** — write tools: `opentable_book`, `opentable_cancel`, `opentable_add_favorite`, `opentable_remove_favorite`. Needs reverse-engineering the POST endpoints behind Reserve / Cancel / Heart. Same live-cookie constraint as `find_slots`.
- **Dropped from v0.1.0 plan** — `*_notify` tools. OpenTable doesn't appear to expose a user-facing notify-me subscription feature the way Resy's Priority Notify does (`/user/notifications`, `/notify-me`, etc. all 404). `header.userNotifications` in state is empty and appears to be a push-notification feed, not a bookable-slot watch.

## Notes

- **Cookie lifecycle is manual in v0.2.** Akamai's challenge cookie is short-lived and binds to the original browser's TLS fingerprint. A Playwright-backed refresh flow could make this automatic — that's a separate design question, tracked in [issue #1](https://github.com/chrischall/opentable-mcp/issues/1).
- **No passwords in play.** OpenTable switched to passwordless OTP some time ago. If you've got an ancient account with a password: you'll still log in via the email-OTP flow these days.

---

This project was developed and is maintained by AI (Claude Opus 4.7).
