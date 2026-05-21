# opentable-mcp security model

This document explains what opentable-mcp does on your machine and why. The short version: it doesn't store your OpenTable credentials anywhere. It uses your browser's signed-in session via a localhost-only WebSocket bridge.

## Trust boundaries

| What | Where it lives | Who sees it |
|---|---|---|
| OpenTable session | Your Chrome browser (cookies set by opentable.com on login) | The browser. Never copied into opentable-mcp's process. |
| Akamai `_abck` bot-management cookie | Your Chrome browser | The browser. Bound to your browser's TLS fingerprint; can't be exfiltrated. |
| WebSocket bridge | `127.0.0.1:37149` (loopback only) | Only processes on your local user account. |
| MCP stdio | Pipe from Claude Code / your MCP host to the opentable-mcp process | Your MCP host and this process. |

opentable-mcp **never asks for** or **stores** your OpenTable email, password, or session tokens. It can't — by design, those live in your browser.

## How it works

1. opentable-mcp starts. It opens a WebSocket listener on `127.0.0.1:37149` (loopback interface only — not `0.0.0.0`).
2. The companion [fetchproxy](https://github.com/chrischall/fetchproxy) Chrome extension connects from your signed-in opentable.com tab.
3. When you ask Claude to "list my reservations", opentable-mcp tells the extension to issue `GET https://www.opentable.com/user/dining-dashboard` from your tab. The browser sends your cookies; OpenTable's server validates them; the response flows back through the WebSocket.
4. opentable-mcp parses the response and returns structured data via the MCP protocol.

The reason for this architecture: OpenTable's edge (Akamai Bot Manager) refuses non-browser HTTP clients. The only way to read your reservations programmatically is to ride your real browser's TLS fingerprint + behavioral signals.

## What this implies

- **You need to be signed into opentable.com in Chrome** for opentable-mcp to do anything. If you sign out, every tool call returns an "extension offline" error until you sign back in.
- **No keys or tokens to manage.** No env vars, no `.env` file, no manual session capture. Sign in once via the browser.
- **Per-MCP domain scope.** The extension enforces a domain allowlist (`opentable.com`). Even if opentable-mcp were compromised, it cannot fetch from any other domain through the bridge.
- **No `eval_js`, no `read_cookies`, no `read_local_storage` capabilities.** The protocol only allows `fetch` — no JavaScript execution in your tabs, no cookie exfiltration, no storage reads. Browser session state stays in the browser.

## Per-fetchproxy-version capabilities

opentable-mcp currently declares only the **`fetch`** capability when pairing with the fetchproxy extension. You'll see this in the pair-approval popup the first time you connect:

> opentable-mcp wants to access opentable.com  
> • HTTP fetches

There are no `read_cookies` / `read_local_storage` / `capture_request_header` capabilities requested.

## Network exposure

The localhost WebSocket listener is bound to `127.0.0.1` only. It is not reachable from other hosts on your network and not exposed externally.

The WebSocket server itself comes from [`@fetchproxy/server`](https://www.npmjs.com/package/@fetchproxy/server), which:

- Rejects WebSocket upgrades with public `Origin` headers (drive-by webpage defense).
- End-to-end encrypts every payload between the MCP and the browser extension (AES-256-GCM after an ECDH handshake bound to a per-MCP identity key).
- Has its own threat model documented at https://github.com/chrischall/fetchproxy/blob/main/docs/SECURITY.md.

## What's out of scope

- A compromised local user account. Anything running under your user can hijack your browser too; opentable-mcp doesn't expand that attack surface.
- A user who clicks "Approve" on a malicious-MCP pair prompt that claims to be opentable-mcp. The extension shows the package name + domain + capability list; reading them is on the user.
- OpenTable's own servers. opentable-mcp only mediates HTTP through your session.

## Reporting issues

GitHub Security Advisories on `chrischall/opentable-mcp`, or email `chris.c.hall@gmail.com`.
