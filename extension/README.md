# opentable-mcp companion extension

Chrome extension that bridges the `opentable-mcp` MCP server to your
signed-in opentable.com tab. Every OpenTable request the MCP server
makes is relayed through the page's own `fetch`, so Akamai sees a
real browser and nothing ever hits their bot wall.

## Install (developer mode)

1. Clone this repo and run `npm install && npm run build` in the root.
2. Open `chrome://extensions` in Chrome (or any Chromium browser with
   `chrome.scripting` support).
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and choose the `extension/` folder.
5. Sign in to `https://www.opentable.com/` in that same Chrome profile.

You'll know it worked when the toolbar icon shows a **green dot**.

### Status dot reference

| Badge | WS | Tab | Meaning |
| --- | --- | --- | --- |
| Green ● | open | found | Fully operational. |
| Yellow ● | open | none | Waiting for an opentable.com tab. Click **Open OpenTable** in the popup. |
| Red ● | closed | — | No MCP server on `127.0.0.1:37149`. Start `node dist/bundle.js` (or any MCP client that spawns it). |

Click the badge to open the popup — three rows show the current WS /
tab / auth state, plus **Reconnect** and **Open OpenTable** buttons.

## Reloading the extension

Chrome doesn't hot-reload unpacked extensions. After editing any file
in `extension/`:

1. Go to `chrome://extensions`.
2. Click the circular **Reload** icon on the *opentable-mcp companion*
   card.

The extension auto-re-injects its content scripts into every existing
opentable.com tab on reload, so you don't need to hard-reload tabs.

## How it works

### File map

| File | World | Role |
| --- | --- | --- |
| `manifest.json` | — | MV3 manifest; two `content_scripts` entries (isolated + MAIN). |
| `background.js` | service worker | Owns the WS connection; routes `fetch` RPCs to the tab; self-heals dead content scripts. |
| `content.js` | isolated | Listens for `fetch` messages from the SW; calls `window.fetch(url, { credentials: 'include' })`. Runs in an isolated JS world (no access to page globals). |
| `capture-logger.js` | MAIN | XHR/fetch logger for endpoint discovery (dumps to `window.__otMcpCaptures`); also syncs `window.__CSRF_TOKEN__` into `document.documentElement.dataset.otMcpCsrf` so the isolated world can see it. |
| `popup.html` / `popup.js` | popup | Status UI: three dots, Reconnect + Open OpenTable buttons. |
| `icons/` | — | Optional icons (Chrome shows a letter fallback if missing). |

### Request lifecycle

```
MCP server                    Service worker           Content script (isolated)      Page (MAIN)
    │   request frame            │                            │                            │
    │───────────────────────────▶│  chrome.tabs.sendMessage   │                            │
    │   op: fetch, id, init      │───────────────────────────▶│  (isolated world)          │
    │                            │                            │  fetch(url, credentials)   │
    │                            │                            │───────────────────────────▶│
    │                            │                            │   (real cookies, TLS)      │
    │                            │                            │◀───────────────────────────│
    │                            │◀───────────────────────────│  {ok, status, body, url}   │
    │   response frame           │                            │                            │
    │◀───────────────────────────│                            │                            │
```

### WS protocol

| Frame | Direction | Purpose |
| --- | --- | --- |
| `{type:"hello",protocol:1,extensionVersion}` | ext → server | Greeting on WS open. |
| `{type:"ready",tabId,url}` | ext → server | Extension has found an opentable tab and is ready to relay fetches. |
| `{type:"ping"}` / `{type:"pong"}` | both | Keep-alive every 20s (from the server). |
| `{type:"request",id,op:"fetch",init}` | server → ext | Relay a fetch. `init` = `{path,method,headers?,body?}`. |
| `{type:"response",id,ok,status?,body?,url?,error?}` | ext → server | Result. `ok:false` carries an `error` string. |

Port: `127.0.0.1:37149`. One active extension at a time; a second
connection is closed with code 1000 (`Another extension already
connected`).

## Troubleshooting

- **Badge stays red.** No MCP server listening. The MCP server
  (`dist/bundle.js`) starts one on boot and shuts it down on exit —
  so if you're not running it, the WS has no listener.
- **"Could not establish connection. Receiving end does not exist."**
  The content script died in the tab (usually after an extension
  reload). The SW automatically re-injects and retries once via
  `chrome.scripting.executeScript`, so this shouldn't surface. If it
  does, reload the extension from `chrome://extensions`.
- **Behavioral challenge page.** Akamai occasionally interrupts a
  long-idle tab with "verify you're human". Click through once — the
  same cookies are then valid for the MCP server.
- **SW sleeps / slow first request.** MV3 service workers get killed
  after ~30s idle. We hold a 20s ping and a 25s `chrome.alarms` tick
  to stay warm. On cold wake the first fetch can add ~2-5s while the
  WS reconnects.
- **Write tool returns `PersistedQueryNotFound`.** OpenTable redeployed
  and invalidated the cached sha256Hash. Open a restaurant page, open
  DevTools → Console, run `copy(JSON.stringify(window.__otMcpCaptures, null, 2))`,
  and re-grab the hash for that opname.

## Adding/debugging endpoints

The capture logger exists precisely for this. Open any opentable.com
page, poke around (book, favorite, cancel, whatever), then in the
DevTools console:

```js
copy(JSON.stringify(window.__otMcpCaptures, null, 2))
```

That JSON has `{url, method, body, status, responseBody}` for every
POST/PUT/DELETE to `/dapi/*`, `/dtp/*`, or `/restref/*`. Paste it
into a scratch file, extract the persisted-query hash (for GraphQL)
or the JSON body shape, and wire up a new tool.

## Web Store note

v0.3.0-alpha ships without Web Store icons — Chrome renders a letter
fallback. Icons + a Web Store listing are a future polish pass, not
a blocker.
