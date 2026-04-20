# opentable-mcp

OpenTable reservation management as an MCP server for Claude — search restaurants, book tables, manage reservations, favorites, and notify-me via natural language.

> ⚠️ **v0.1.0 status: endpoints unverified, blocked by bot detection.** OpenTable does not publish a public API. This server was designed to call OpenTable's private web endpoints with an email+password cookie session (same pattern as [resy-mcp](https://github.com/chrischall/resy-mcp)), but OpenTable fingerprints TLS / HTTP‑2 traffic aggressively and resets the connection on Node's default `fetch`. A `curl` with a browser User-Agent gets `INTERNAL_ERROR`; plain `curl` gets a 503 from an S3 error page. The smoke probe (`npm run smoke`) currently returns 403 on login from any non-browser client tested so far.
>
> The code, tests (47 passing), and packaging are complete — what's missing is a way to bypass the bot wall. See [open issue: pivot to browser automation or TLS impersonation](https://github.com/chrischall/opentable-mcp/issues/1).

## Tools

| Tool | Purpose |
| --- | --- |
| `opentable_get_profile` | Current user profile (name, email, loyalty tier) |
| `opentable_search_restaurants` | Search restaurants with availability for a location + date + party size |
| `opentable_get_restaurant` | Full restaurant details |
| `opentable_find_slots` | List bookable slots at a restaurant |
| `opentable_book` | Book a reservation (composite: find → book) |
| `opentable_list_reservations` | Upcoming / past reservations |
| `opentable_cancel` | Cancel by reservation_id |
| `opentable_list_favorites` | Favorited restaurants |
| `opentable_add_favorite` / `opentable_remove_favorite` | Manage favorites |
| `opentable_list_notify` | Notify-me subscriptions |
| `opentable_add_notify` / `opentable_remove_notify` | Manage notify-me |

## Install

```bash
npm install
npm run build
```

## Configure

Copy `.env.example` to `.env` and fill in:

```
OPENTABLE_EMAIL=you@example.com
OPENTABLE_PASSWORD=changeme
```

For MCPB / Claude Desktop install, the packaged manifest prompts for `OpenTable Email` and `OpenTable Password` at configure time.

Accounts with MFA enabled are not supported in v1. Use an account without MFA or create an app-specific credential.

## Run (local stdio)

```bash
node dist/bundle.js
```

## Test

```bash
npm test             # unit tests (mocked fetch)
npm run smoke        # live endpoint probe — requires real .env
```

## Notes

- **Bot detection is the v0.1.0 blocker.** OpenTable rejects requests that don't match a real browser's TLS/HTTP‑2 fingerprint. The client handles the symptom (403 + "bot-detection challenge") but can't defeat the cause. Paths forward: browser automation (Playwright / `patchright`, same as the [Strider Labs reference implementation](https://github.com/markswendsen-code/mcp-opentable)), or TLS impersonation (e.g. `cycletls`, `node-libcurl-impersonate`).
- Endpoint paths under `/api/v2/...` and the GraphQL search op are candidates — verified once bot detection is bypassed.

---

This project was developed and is maintained by AI (Claude Opus 4.7).
