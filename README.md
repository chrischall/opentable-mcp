# opentable-mcp

OpenTable reservation reader as an MCP server for Claude — list your reservations, profile, and saved restaurants via natural language.

> **v0.2.0-alpha.4 status: read-only user-data tools, live-verified.** Three tools ship, all backed by the authenticated `/user/*` SSR pages. Search, restaurant-detail, and write/booking tools are **not implemented** — OpenTable's Akamai Bot Manager serves a behavioral-challenge page for public paths (`/`, `/s`, `/r/…`) that no non-browser client can pass without running Chrome JS. The architectural story for those paths is in the Roadmap below.

## How it works

OpenTable is a Next.js app with no public JSON API — each authenticated page embeds its React state as `"__INITIAL_STATE__":{...}` in the HTML. This server:

1. Accepts session cookies exported from an already-logged-in Chrome tab (Akamai's `_abck` plus OpenTable's `authCke` and friends).
2. Uses [`cycletls`](https://www.npmjs.com/package/cycletls) to issue HTTPS requests with a desktop-Chrome JA3 TLS fingerprint (Node's default `fetch` is reset with `HTTP/2 INTERNAL_ERROR` by Akamai).
3. Fetches the relevant `/user/*` page, extracts `__INITIAL_STATE__` via a brace-balanced JSON walker, and maps the subtree for that tool into tidy JSON.

No Playwright. No headless Chromium download. No MFA/password handling.

## Tools

| Tool | Source page | Returns |
| --- | --- | --- |
| `opentable_list_reservations` | `/user/dining-dashboard` | Upcoming / past / all reservations with confirmation number, security token, date, time, party size, status |
| `opentable_get_profile` | `/user/dining-dashboard` | Name, email, phones, loyalty points, home metro, member-since, VIP flag |
| `opentable_list_favorites` | `/user/favorites` | Saved restaurants: id, name, cuisine, neighborhood, price band, rating, URL |

Live-verified against a real account. Typical latency: one cycletls round-trip per call (~500 ms).

## Install

```bash
npm install
npm run build
```

## Configure

OpenTable's auth is passwordless email-OTP (or SMS). Rather than automate the OTP dance, `npm run auth` just reads the already-authenticated session cookies from your browser.

### `npm run auth`

```bash
npm run auth                 # prompts → reads clipboard → writes ~/.config/opentable-mcp/cookies.txt
npm run auth -- --open       # also opens opentable.com in your default browser
npm run auth -- --print      # also prints the cookie string (for MCPB paste)
npm run auth -- .env         # instead writes OPENTABLE_COOKIES=<value> to .env
```

The flow:

1. Sign in to opentable.com in your regular **Chrome** or **Safari** (email-OTP click-through).
2. Open DevTools (Chrome) or Web Inspector (Safari → Settings → Advanced → "Show features for web developers") → Console → run `copy(document.cookie)`.
3. Come back to the terminal and press Enter — the script reads from your clipboard, validates that it has both `authCke` and `_abck`, and writes the mode-600 file the server reads.

Why it has to be your regular browser: Akamai detects puppeteer-driven Chrome regardless of stealth flags (CDP presence and `--disable-blink-features=AutomationControlled` are both tells). Your actual browser has a real TLS/JS fingerprint Akamai is happy with; we just borrow the resulting cookies.

### Cookie sources, in order of precedence

1. `OPENTABLE_COOKIES` env var (direct, wins over file).
2. `OPENTABLE_COOKIES_PATH` env var (path to file).
3. Default: `~/.config/opentable-mcp/cookies.txt`.

For MCPB / Claude Desktop install, the manifest prompts for "OpenTable Session Cookies" at configure time and propagates them via `OPENTABLE_COOKIES`.

### Refreshing cookies

Akamai rotates `_abck` every few hours. When the server returns `SessionExpiredError`:

1. Visit opentable.com (you're still signed in).
2. DevTools / Web Inspector Console → `copy(document.cookie)`.
3. `npm run auth` → Enter.

Thirty seconds, no OTP round.

## Run (local stdio)

```bash
node dist/bundle.js
```

## Test

```bash
npm test                           # 52 unit tests (mocked fetch)
npm run smoke                      # live round-trip of all 3 registered tools
```

## Why search / restaurant-detail / booking aren't included

The short version: **`/user/*` paths let us in; every other OpenTable path gets a behavioral challenge we can't solve from Node.**

The long version. Akamai Bot Manager applies different policies per URL group:

- **`/user/*`** (dining-dashboard, favorites) — the `authCke` session cookie short-circuits bot scrutiny; cycletls + our session cookies gets a clean 200 with the real page.
- **Public paths** (`/`, `/s?...`, `/r/{slug}`) — strict TLS-fingerprint + JS-challenge validation. We tried three approaches; all failed:
  - **cycletls** (JA3 spoof): 403 Access Denied from Akamai's edge.
  - **impit** (Apify's Rust-based impersonator): 200 response, but served Akamai's behavioral challenge page (2.6 KB of JS that "solves" for a fresh `_abck` — real Chrome runs it automatically, Node can't).
  - **puppeteer-core with stealth flags**: 403 + "Access Denied" (CDP presence is itself detectable).

The parsers for search and restaurant detail (`src/parse-search.ts`, `src/parse-restaurant.ts`) and their tools (`src/tools/search.ts`, `src/tools/restaurants.ts`) exist in the repo — they're unit-tested and correct — but the tools are **not registered in `src/index.ts`** because their transport-layer fetch fails against live OpenTable. They're kept as research for future work.

Real ways to unblock them:

1. **In-browser fetch bridge.** A Chrome extension or userscript in the user's authenticated browser relays HTTP requests to the MCP server over localhost. Akamai is happy because every fetch is from the real browser. Most reliable; most setup overhead.
2. **`curl-impersonate-chrome`.** Native binary, TLS fingerprint closer than cycletls. Probably gets past JA3-only checks; likely still hits the behavioral challenge. Worth a test, not a guaranteed win.
3. **`undetected-chromedriver`-style automation.** Third-party Chromium builds that strip CDP tells. Maintenance burden.

## Roadmap

- **Deferred: `opentable_find_slots`.** OpenTable does NOT include slot availability in SSR HTML — the restaurant page hydrates, then POSTs to `/dapi/fe/gql?opname=RestaurantsAvailability` for slots. Same public-path Akamai wall as above, plus we'd need to capture the GraphQL query body.
- **Deferred: write tools** — `opentable_book`, `opentable_cancel`, `opentable_add_favorite`, `opentable_remove_favorite`. Same wall.
- **Dropped from v0.1.0 plan** — `*_notify` tools. OpenTable no longer exposes a user-facing notify-me subscription surface (`/user/notifications`, `/notify-me`, etc. all 404). `header.userNotifications` is a push-notification feed.

---

This project was developed and is maintained by AI (Claude Opus 4.7).
