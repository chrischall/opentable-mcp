# CLAUDE.md — opentable-mcp

Guidance for Claude working in this repo.

## Commands

- `npm test` — vitest, mocked fetch, no network.
- `npm run build` — tsc + esbuild bundle to `dist/bundle.js`.
- `npm run smoke` — live probe of `/api/v2/users/me`, `/users/me/reservations`, `/users/me/favorites`, `/users/me/notifications` using `.env`.
- `npx tsc --noEmit` — typecheck only.

## Layout

- `src/client.ts` — `OpenTableClient`: lazy login, in-memory cookie jar, 401/419 re-login+retry, 429 backoff+retry, 403 captcha detection, 500-auth handling.
- `src/cookie-jar.ts` — minimal cookie parsing/emission utility.
- `src/tools/*.ts` — one file per concern (user / restaurants / reservations / favorites / notify). Each exports a `registerXxxTools(server, client)` function.
- `src/index.ts` — MCP bootstrap; wires tool registrations over stdio.
- `tests/` — 1:1 mirror of `src/`, plus `tests/helpers.ts` for the in-memory MCP harness.

## Conventions

- All tools are `opentable_*`-prefixed.
- Tool return shape: `{ content: [{ type: 'text', text: JSON.stringify(..., null, 2) }] }`.
- Readonly tools set `annotations: { readOnlyHint: true }`.
- Prefer JSON bodies (OpenTable is JSON-first); use `URLSearchParams` only if a live endpoint demands form-encoding.
- Write a failing test before implementation. Keep tests in `tests/tools/<name>.test.ts` and mock `OpenTableClient.request`.

## Known unknowns

Endpoint paths under `/api/v2/...` and the GraphQL search operation are candidates pending smoke verification. See `scripts/smoke.ts` and the "open questions" block in `docs/superpowers/specs/2026-04-20-opentable-mcp-design.md`.
