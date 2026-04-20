# opentable-mcp

OpenTable reservation management as an MCP server for Claude — search restaurants, book tables, manage reservations, favorites, and notify-me via natural language.

> ⚠️ OpenTable does not publish a comprehensive API. This server uses the same private endpoints opentable.com's web app calls, authenticated with your email + password (session cookie). Use at your own discretion.

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

- Bot-detection: OpenTable may return a captcha challenge (403). If that happens, log in via a browser on this machine once to warm up the session, or retry later.
- Endpoint paths are reverse-engineered; if live endpoints differ, run `npm run smoke` and adjust.

---

This project was developed and is maintained by AI (Claude Opus 4.7).
