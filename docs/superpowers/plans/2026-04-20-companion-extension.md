# v0.3 Companion Chrome Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cycletls HTTP transport with a Chrome MV3 companion extension that proxies fetches through the user's authenticated opentable.com tab, unblocking all 10 tools (read-only + write).

**Architecture:** Three processes: Node MCP server, Chrome extension (service worker + content script), opentable.com tab. A single WebSocket on `127.0.0.1:37149` carries JSON frames (`hello`/`ready`/`request`/`response`/`ping`/`pong`). Server sends `{path, method, body?}`, extension forwards to content script, content script fetches in page context with `credentials: 'include'`, response returns up the chain for parsing in the server.

**Tech Stack:** TypeScript/ESM on Node ≥18; `ws` for server side; plain MV3 JS for the extension; `vitest` for tests; `esbuild` for bundling; `zod` for input validation. Drops `cycletls` and `dotenv` env handling.

**Spec:** [`docs/superpowers/specs/2026-04-20-companion-extension-design.md`](../specs/2026-04-20-companion-extension-design.md)

**Working directory:** `/Users/chris/git/opentable-mcp`. Branch `v0.3-companion-extension` (spec committed; main is v0.2.0-alpha.4).

**Execution phases** (each phase is independently shippable):

- **A.** Extension + WS transport + existing 3 tools (end: cycletls replaced, 3 tools still work live-green).
- **B.** Re-register `search_restaurants` + `get_restaurant` (no new parsers; just wire).
- **C.** Discovery pass: capture the 5 unknown endpoints (`RestaurantsAvailability`, book, cancel, add_favorite, remove_favorite) from the live site using the extension's XHR logger.
- **D.** `find_slots` tool.
- **E.** Write tools (`book`, `cancel`, `add_favorite`, `remove_favorite`).
- **F.** Ship: README rewrite, manifest update, release.

---

## Task 1: Extension scaffold + manifest

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/background.js` (empty stub)
- Create: `extension/content.js` (empty stub)
- Create: `extension/popup.html` (minimal stub)
- Create: `extension/popup.js` (empty stub)
- Create: `extension/icons/README.md` (documents icon placeholders)

- [ ] **Step 1: Create the `extension/` tree**

```bash
mkdir -p extension/icons
```

- [ ] **Step 2: Write `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "opentable-mcp companion",
  "version": "0.3.0",
  "description": "Bridges the opentable-mcp server to your signed-in OpenTable tab.",
  "action": { "default_popup": "popup.html", "default_title": "opentable-mcp" },
  "permissions": ["tabs", "alarms"],
  "host_permissions": [
    "https://www.opentable.com/*",
    "http://127.0.0.1:37149/*"
  ],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["https://www.opentable.com/*"],
      "js": ["content.js"],
      "run_at": "document_start"
    }
  ]
}
```

- [ ] **Step 3: Write `extension/background.js` (stub)**

```js
// Service worker — WS connection + tab routing live here.
// Filled in by Task 3.
console.log('[opentable-mcp] background.js loaded (stub)');
```

- [ ] **Step 4: Write `extension/content.js` (stub)**

```js
// Content script — runs in every opentable.com tab. Receives fetch
// requests from the service worker and executes them in page context.
// Filled in by Task 4.
console.log('[opentable-mcp] content.js loaded (stub) on', location.href);
```

- [ ] **Step 5: Write `extension/popup.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; width: 280px; padding: 12px; margin: 0; }
      h3 { margin: 0 0 8px 0; font-size: 14px; }
      .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; vertical-align: middle; }
      .dot.green { background: #22c55e; }
      .dot.yellow { background: #eab308; }
      .dot.red { background: #ef4444; }
      button { width: 100%; padding: 6px; margin-top: 8px; }
    </style>
  </head>
  <body>
    <h3>opentable-mcp companion</h3>
    <div class="row"><span><span id="ws-dot" class="dot red"></span>WebSocket</span><span id="ws-status">—</span></div>
    <div class="row"><span><span id="tab-dot" class="dot red"></span>OpenTable tab</span><span id="tab-status">—</span></div>
    <div class="row"><span><span id="auth-dot" class="dot red"></span>Signed in</span><span id="auth-status">—</span></div>
    <button id="open-btn">Open OpenTable tab</button>
    <button id="reconnect-btn">Reconnect WebSocket</button>
    <script src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 6: Write `extension/popup.js` (stub)**

```js
// Populated in Task 5.
document.getElementById('open-btn').onclick = () => {
  chrome.tabs.create({ url: 'https://www.opentable.com/', pinned: true });
};
document.getElementById('reconnect-btn').onclick = () => {
  chrome.runtime.sendMessage({ type: 'reconnect' });
};
```

- [ ] **Step 7: Write `extension/icons/README.md`**

```markdown
Icon PNGs live here — `icon-16.png`, `icon-48.png`, `icon-128.png`.
For v0.3 we ship without icons (Chrome shows a letter fallback). Add
real icons later when we do a Web Store polish pass.
```

- [ ] **Step 8: Commit**

```bash
git add extension/
git commit -m "$(cat <<'EOF'
extension: scaffold manifest.json + stubs

MV3 manifest with tabs + alarms permissions and host access to
opentable.com and the local WS port. background.js / content.js
are stubs; popup.html has status rows ready for wiring in later
tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: WS server module (TDD)

Build a `ws`-backed server that owns one connection at a time, correlates requests/responses by id, pings every 20s, and rejects extra connections.

**Files:**
- Create: `src/ws-server.ts`
- Create: `tests/ws-server.test.ts`

- [ ] **Step 1: Install `ws`**

Run: `npm install ws && npm install --save-dev @types/ws`
Expected: 0 vulnerabilities.

- [ ] **Step 2: Write failing tests**

```ts
// tests/ws-server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { OpenTableWsServer } from '../src/ws-server.js';

let server: OpenTableWsServer;
const PORT = 37190 + Math.floor(Math.random() * 500);

beforeEach(() => {
  server = new OpenTableWsServer({ port: PORT });
});
afterEach(async () => {
  await server.close();
});

async function openClient(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  return ws;
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    ws.once('message', (raw) => resolve(JSON.parse(String(raw))))
  );
}

describe('OpenTableWsServer', () => {
  it('starts listening after start()', async () => {
    await server.start();
    const ws = await openClient();
    ws.close();
  });

  it('accepts a hello + ready handshake, then serves a request', async () => {
    await server.start();
    const ws = await openClient();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.3.0' }));
    ws.send(JSON.stringify({ type: 'ready', tabId: 42, url: 'https://www.opentable.com/' }));

    // Kick off a fetch from server side
    const pending = server.fetch({ path: '/foo', method: 'GET' });
    const req = (await nextMessage(ws)) as {
      type: string;
      id: number;
      op: string;
      init: { path: string; method: string };
    };
    expect(req.type).toBe('request');
    expect(req.op).toBe('fetch');
    expect(req.init.path).toBe('/foo');

    ws.send(
      JSON.stringify({
        type: 'response',
        id: req.id,
        ok: true,
        status: 200,
        body: '<html>ok</html>',
        url: 'https://www.opentable.com/foo',
      })
    );

    const result = await pending;
    expect(result.status).toBe(200);
    expect(result.body).toBe('<html>ok</html>');
  });

  it('rejects a fetch() when no extension is connected', async () => {
    await server.start();
    // No client. Expect queue timeout to kick in.
    server.setConnectTimeoutMs(50);
    await expect(server.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /extension offline/i
    );
  });

  it('times out per-request when the extension does not reply', async () => {
    await server.start();
    const ws = await openClient();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.3.0' }));
    ws.send(JSON.stringify({ type: 'ready', tabId: 1, url: 'https://www.opentable.com/' }));
    server.setRequestTimeoutMs(100);
    await expect(server.fetch({ path: '/slow', method: 'GET' })).rejects.toThrow(
      /timed out/i
    );
  });

  it('keeps the first connection and closes a second one', async () => {
    await server.start();
    const first = await openClient();
    first.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.3.0' }));
    first.send(JSON.stringify({ type: 'ready', tabId: 1, url: 'https://www.opentable.com/' }));

    const second = await openClient();
    await new Promise<void>((r) => second.once('close', () => r()));
    // first still usable
    expect(first.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects pending requests when the extension disconnects', async () => {
    await server.start();
    const ws = await openClient();
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.3.0' }));
    ws.send(JSON.stringify({ type: 'ready', tabId: 1, url: 'https://www.opentable.com/' }));
    const pending = server.fetch({ path: '/x', method: 'GET' });
    ws.close();
    await expect(pending).rejects.toThrow(/disconnect/i);
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run tests/ws-server.test.ts`
Expected: FAIL — `Cannot find module '../src/ws-server.js'`.

- [ ] **Step 4: Implement `src/ws-server.ts`**

```ts
import { WebSocketServer, WebSocket } from 'ws';

export interface FetchInit {
  path: string;
  method: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResult {
  status: number;
  body: string;
  url: string;
}

interface PendingRequest {
  resolve: (v: FetchResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface ServerOptions {
  port?: number;
}

const PING_INTERVAL_MS = 20_000;

export class OpenTableWsServer {
  private readonly port: number;
  private wss: WebSocketServer | null = null;
  private active: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private pingTimer: NodeJS.Timeout | null = null;
  private connectTimeoutMs = 10_000;
  private requestTimeoutMs = 30_000;
  private readyResolvers: Array<() => void> = [];

  constructor(opts: ServerOptions = {}) {
    this.port = opts.port ?? 37149;
  }

  setConnectTimeoutMs(ms: number): void {
    this.connectTimeoutMs = ms;
  }

  setRequestTimeoutMs(ms: number): void {
    this.requestTimeoutMs = ms;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
      this.wss.on('listening', () => resolve());
      this.wss.on('error', reject);
      this.wss.on('connection', (ws) => this.handleConnection(ws));
    });
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Server closing'));
    }
    this.pending.clear();
    if (this.active) this.active.close();
    this.active = null;
    await new Promise<void>((r) => {
      if (!this.wss) return r();
      this.wss.close(() => r());
    });
    this.wss = null;
  }

  /**
   * Proxy a fetch through the extension. Throws if the extension is offline
   * beyond the connect timeout, or if the request itself times out.
   */
  async fetch(init: FetchInit): Promise<FetchResult> {
    await this.waitForConnection();
    if (!this.active) {
      throw new Error('opentable-mcp extension offline — install it and open an opentable.com tab');
    }
    const id = this.nextId++;
    return new Promise<FetchResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenTable request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.active!.send(JSON.stringify({ type: 'request', id, op: 'fetch', init }));
    });
  }

  private handleConnection(ws: WebSocket): void {
    if (this.active && this.active.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Another extension already connected');
      return;
    }
    this.active = ws;

    ws.on('message', (raw) => {
      let frame: { type?: string; [k: string]: unknown };
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type === 'hello') {
        // log + no-op; server already accepted the connection.
        return;
      }
      if (frame.type === 'ready') {
        // release any waiters
        const waiters = this.readyResolvers.splice(0);
        for (const r of waiters) r();
        return;
      }
      if (frame.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (frame.type === 'pong') {
        return;
      }
      if (frame.type === 'response' && typeof frame.id === 'number') {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.ok === true) {
          pending.resolve({
            status: Number(frame.status),
            body: String(frame.body ?? ''),
            url: String(frame.url ?? ''),
          });
        } else {
          pending.reject(new Error(String(frame.error ?? 'unknown extension error')));
        }
      }
    });

    ws.on('close', () => {
      if (this.active === ws) this.active = null;
      // Reject all pending
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Extension disconnected during request'));
      }
      this.pending.clear();
    });
  }

  private ping(): void {
    if (this.active && this.active.readyState === WebSocket.OPEN) {
      this.active.send(JSON.stringify({ type: 'ping' }));
    }
  }

  private waitForConnection(): Promise<void> {
    if (this.active && this.active.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.readyResolvers.indexOf(resolve);
        if (idx >= 0) this.readyResolvers.splice(idx, 1);
        reject(new Error('opentable-mcp extension offline — install it and open an opentable.com tab'));
      }, this.connectTimeoutMs);
      this.readyResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
```

- [ ] **Step 5: Run tests to confirm pass**

Run: `npx vitest run tests/ws-server.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/ws-server.ts tests/ws-server.test.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(server): add OpenTableWsServer — single-connection WS bridge

Owns one extension connection at a time. Correlates requests by id,
times out per request, rejects pending on disconnect, ping/pong
keepalive every 20s. Second connection attempts are closed.

Dep: ws (runtime), @types/ws (dev).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Service worker (background.js) — WS + tab routing

**Files:**
- Modify: `extension/background.js` (replace stub)

- [ ] **Step 1: Replace `extension/background.js`**

```js
// Service worker owns the WebSocket to the MCP server and routes
// `fetch` requests to the content script in the opentable.com tab.
//
// MV3 caveats:
// - Service workers sleep after ~30s idle. We ping-pong every 20s and
//   register a chrome.alarms tick every 25s to keep busy.
// - When the worker wakes, we re-open the WS. State is rebuilt from
//   scratch (no in-memory state survives sleep).

const WS_URL = 'ws://127.0.0.1:37149/';
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000];
let reconnectAttempt = 0;
let ws = null;
let currentTabId = null;
const pendingReplies = new Map(); // id → {ws}

chrome.runtime.onInstalled.addListener(() => openWs());
chrome.runtime.onStartup.addListener(() => openWs());

// Keep the SW alive by tick every 25s.
chrome.alarms.create('keepalive', { periodInMinutes: 25 / 60 });
chrome.alarms.onAlarm.addListener(() => openWs());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'reconnect') {
    if (ws) ws.close();
    openWs();
    sendResponse({ ok: true });
  } else if (msg?.type === 'status') {
    sendResponse({
      ws: ws && ws.readyState === WebSocket.OPEN,
      tabId: currentTabId,
    });
  }
  return true;
});

// Track tab lifecycle so we know when to re-open or re-ready.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === currentTabId) {
    currentTabId = null;
    announceReadyIfPossible();
  }
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.url?.startsWith('https://www.opentable.com/')) {
    if (!currentTabId) {
      currentTabId = tabId;
      announceReadyIfPossible();
    }
  }
});

function openWs() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    reconnectAttempt = 0;
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.3.0' }));
    ensureOpenTableTab().then(() => announceReadyIfPossible());
    updateBadge();
  };
  ws.onmessage = (e) => handleServerMessage(e.data);
  ws.onclose = () => {
    ws = null;
    updateBadge();
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose will fire
  };
}

function scheduleReconnect() {
  const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
  reconnectAttempt++;
  setTimeout(openWs, delay);
}

async function ensureOpenTableTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.opentable.com/*' });
  const pinned = tabs.find((t) => t.pinned);
  const chosen = pinned ?? tabs[0];
  if (chosen?.id) {
    currentTabId = chosen.id;
    return;
  }
  const created = await chrome.tabs.create({
    url: 'https://www.opentable.com/',
    pinned: true,
    active: false,
  });
  currentTabId = created.id ?? null;
}

function announceReadyIfPossible() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentTabId) return;
  // get the current URL of the tab (if available) before announcing.
  chrome.tabs.get(currentTabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      currentTabId = null;
      return;
    }
    ws.send(JSON.stringify({ type: 'ready', tabId: currentTabId, url: tab.url ?? '' }));
  });
  updateBadge();
}

async function handleServerMessage(data) {
  let frame;
  try {
    frame = JSON.parse(data);
  } catch {
    return;
  }
  if (frame.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }
  if (frame.type === 'pong') return;
  if (frame.type === 'request' && frame.op === 'fetch') {
    await handleFetchRequest(frame);
  }
}

async function handleFetchRequest(frame) {
  if (!currentTabId) {
    await ensureOpenTableTab();
  }
  if (!currentTabId) {
    ws.send(JSON.stringify({ type: 'response', id: frame.id, ok: false, error: 'no opentable tab' }));
    return;
  }
  try {
    const reply = await chrome.tabs.sendMessage(currentTabId, {
      type: 'fetch',
      id: frame.id,
      init: frame.init,
    });
    ws.send(JSON.stringify({ type: 'response', id: frame.id, ...reply }));
  } catch (e) {
    ws.send(
      JSON.stringify({
        type: 'response',
        id: frame.id,
        ok: false,
        error: String(e?.message ?? e),
      })
    );
  }
}

function updateBadge() {
  const state =
    ws && ws.readyState === WebSocket.OPEN
      ? currentTabId
        ? { color: '#22c55e', text: '●' } // green
        : { color: '#eab308', text: '●' } // yellow
      : { color: '#ef4444', text: '●' }; // red
  chrome.action.setBadgeText({ text: state.text });
  chrome.action.setBadgeBackgroundColor({ color: state.color });
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/background.js
git commit -m "$(cat <<'EOF'
extension: service worker — WS + tab routing

Opens a WS to ws://127.0.0.1:37149 on install/startup. Reconnects with
exponential backoff on close. Finds or creates a pinned opentable.com
tab. Forwards server 'request' frames to the content script and relays
the content script's reply back. chrome.alarms + ping/pong keep the
SW alive past MV3's default 30s idle timer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Content script (content.js) — page-context fetch

**Files:**
- Modify: `extension/content.js` (replace stub)

- [ ] **Step 1: Replace `extension/content.js`**

```js
// Runs on every opentable.com page at document_start. Relays fetch
// requests from the service worker to the page-context fetch, which
// inherits origin/cookies/TLS state the way Akamai expects.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'fetch') return;
  doFetch(msg.init)
    .then((result) => sendResponse(result))
    .catch((err) =>
      sendResponse({ ok: false, error: String(err?.message ?? err) })
    );
  return true; // async sendResponse
});

async function doFetch(init) {
  try {
    const url = init.path.startsWith('http')
      ? init.path
      : `https://www.opentable.com${init.path}`;
    const resp = await fetch(url, {
      method: init.method,
      headers: init.headers ?? {},
      body: init.body,
      credentials: 'include',
    });
    const body = await resp.text();
    return {
      ok: true,
      status: resp.status,
      body,
      url: resp.url,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/content.js
git commit -m "$(cat <<'EOF'
extension: content script — page-context fetch relay

Listens for chrome.runtime 'fetch' messages from the service worker,
runs fetch() in page context with credentials: 'include', returns
the response text/status back. No parsing, no tool-specific logic —
dumb relay.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Popup status UI

**Files:**
- Modify: `extension/popup.js`

- [ ] **Step 1: Replace `extension/popup.js`**

```js
function setDot(id, color) {
  const el = document.getElementById(id);
  el.classList.remove('green', 'yellow', 'red');
  el.classList.add(color);
}

function setText(id, text) {
  document.getElementById(id).textContent = text;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  if (status?.ws) {
    setDot('ws-dot', 'green');
    setText('ws-status', 'connected');
  } else {
    setDot('ws-dot', 'red');
    setText('ws-status', 'disconnected');
  }

  if (status?.tabId) {
    try {
      const tab = await chrome.tabs.get(status.tabId);
      setDot('tab-dot', 'green');
      setText('tab-status', new URL(tab.url).pathname || '/');
    } catch {
      setDot('tab-dot', 'red');
      setText('tab-status', 'closed');
    }
  } else {
    setDot('tab-dot', 'yellow');
    setText('tab-status', 'none');
  }

  // Probe sign-in by looking for the authCke cookie.
  const authCookies = await chrome.cookies.getAll({
    domain: 'opentable.com',
    name: 'authCke',
  }).catch(() => []);
  if (authCookies.length > 0) {
    setDot('auth-dot', 'green');
    setText('auth-status', 'yes');
  } else {
    setDot('auth-dot', 'red');
    setText('auth-status', 'no — please sign in');
  }
}

document.getElementById('open-btn').onclick = async () => {
  const existing = await chrome.tabs.query({ url: 'https://www.opentable.com/*' });
  if (existing.length > 0) {
    chrome.tabs.update(existing[0].id, { active: true });
  } else {
    chrome.tabs.create({ url: 'https://www.opentable.com/', pinned: true });
  }
  window.close();
};

document.getElementById('reconnect-btn').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(refresh, 500);
};

refresh();
setInterval(refresh, 2000);
```

- [ ] **Step 2: Add `cookies` permission to manifest**

The popup uses `chrome.cookies.getAll`. Edit `extension/manifest.json`:

Replace `"permissions": ["tabs", "alarms"],` with:
```json
  "permissions": ["tabs", "alarms", "cookies"],
```

- [ ] **Step 3: Commit**

```bash
git add extension/popup.js extension/manifest.json
git commit -m "$(cat <<'EOF'
extension: popup UI with WS / tab / auth status

Shows three coloured dots (WS connected, OpenTable tab present, auth
cookie present) and refreshes every 2s while the popup is open. Two
buttons: open/focus the tab, force WS reconnect. chrome.cookies
permission added to probe the authCke cookie.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Rewrite `src/client.ts` around the WS server (TDD)

**Files:**
- Modify: `src/client.ts` (wholesale replacement)
- Modify: `tests/client.test.ts` (new, since v0.2's was deleted when we went SSR)

Wait — `src/client.ts` is still the v0.2 cycletls version on this branch. We're rewriting it against `OpenTableWsServer` so the rest of the server can use the same API shape (`fetchHtml`, plus a new `fetchJson`).

- [ ] **Step 1: Write failing tests for the new client**

```ts
// tests/client.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { OpenTableClient } from '../src/client.js';

const PORT = 37300 + Math.floor(Math.random() * 500);

let client: OpenTableClient;
let ws: WebSocket | null = null;

beforeEach(async () => {
  client = new OpenTableClient({ port: PORT });
  await client.start();
});
afterEach(async () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  await client.close();
});

async function connectFakeExtension(): Promise<WebSocket> {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise<void>((r, j) => {
    sock.once('open', () => r());
    sock.once('error', j);
  });
  sock.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.3.0' }));
  sock.send(JSON.stringify({ type: 'ready', tabId: 1, url: 'https://www.opentable.com/' }));
  return sock;
}

describe('OpenTableClient', () => {
  it('fetchHtml returns the body when the extension replies 200', async () => {
    ws = await connectFakeExtension();
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === 'request') {
        ws!.send(
          JSON.stringify({
            type: 'response',
            id: f.id,
            ok: true,
            status: 200,
            body: '<html>dashboard</html>',
            url: 'https://www.opentable.com/user/dining-dashboard',
          })
        );
      }
    });

    const html = await client.fetchHtml('/user/dining-dashboard');
    expect(html).toBe('<html>dashboard</html>');
  });

  it('fetchHtml throws SessionNotAuthenticatedError if the response looks like a sign-in page', async () => {
    ws = await connectFakeExtension();
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === 'request') {
        ws!.send(
          JSON.stringify({
            type: 'response',
            id: f.id,
            ok: true,
            status: 200,
            body:
              '<html><body><form action="/authenticate/start">' +
              '<button>Sign in</button></form></body></html>',
            url: 'https://www.opentable.com/authenticate/start',
          })
        );
      }
    });
    await expect(client.fetchHtml('/user/dining-dashboard')).rejects.toThrow(
      /sign in/i
    );
  });

  it('fetchHtml throws for non-2xx status', async () => {
    ws = await connectFakeExtension();
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === 'request') {
        ws!.send(
          JSON.stringify({
            type: 'response',
            id: f.id,
            ok: true,
            status: 500,
            body: 'oops',
            url: 'https://www.opentable.com/x',
          })
        );
      }
    });
    await expect(client.fetchHtml('/x')).rejects.toThrow(/500/);
  });

  it('fetchJson POSTs JSON and parses the reply', async () => {
    ws = await connectFakeExtension();
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === 'request') {
        const body = JSON.parse(f.init.body);
        ws!.send(
          JSON.stringify({
            type: 'response',
            id: f.id,
            ok: true,
            status: 200,
            body: JSON.stringify({ echoed: body }),
            url: 'https://www.opentable.com/thing',
          })
        );
      }
    });
    const result = await client.fetchJson<{ echoed: { n: number } }>(
      '/thing',
      { method: 'POST', body: { n: 42 } }
    );
    expect(result.echoed.n).toBe(42);
  });

  it('fetchJson throws if the reply is not valid JSON', async () => {
    ws = await connectFakeExtension();
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === 'request') {
        ws!.send(
          JSON.stringify({
            type: 'response',
            id: f.id,
            ok: true,
            status: 200,
            body: 'not-json',
            url: 'https://www.opentable.com/thing',
          })
        );
      }
    });
    await expect(
      client.fetchJson('/thing', { method: 'POST', body: {} })
    ).rejects.toThrow(/json/i);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/client.test.ts`
Expected: FAIL — current `client.ts` exports don't match (`start`, `close`, `fetchHtml`, `fetchJson`).

- [ ] **Step 3: Replace `src/client.ts`**

```ts
import { OpenTableWsServer, type FetchInit, type FetchResult } from './ws-server.js';

export class SessionNotAuthenticatedError extends Error {
  constructor() {
    super(
      'Not signed in to OpenTable. Open the pinned OpenTable tab in your browser and sign in, then try again.'
    );
    this.name = 'SessionNotAuthenticatedError';
  }
}

export interface OpenTableClientOptions {
  port?: number;
}

export class OpenTableClient {
  private readonly server: OpenTableWsServer;

  constructor(opts: OpenTableClientOptions = {}) {
    this.server = new OpenTableWsServer({ port: opts.port });
  }

  async start(): Promise<void> {
    await this.server.start();
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  /**
   * GET an opentable.com path, return the HTML body. Throws if the response
   * is a non-2xx or appears to be the sign-in page.
   */
  async fetchHtml(path: string): Promise<string> {
    const result = await this.server.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignInPage(result);
    return result.body;
  }

  /**
   * POST/DELETE a JSON body, return the parsed JSON response. Throws on
   * non-2xx, invalid JSON, or sign-in page.
   */
  async fetchJson<T>(
    path: string,
    init: {
      method?: 'POST' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    }
  ): Promise<T> {
    const serialised: FetchInit = {
      path,
      method: init.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    };
    const result = await this.server.fetch(serialised);
    this.throwIfNotOk(result, serialised.method, path);
    this.throwIfSignInPage(result);
    try {
      return JSON.parse(result.body) as T;
    } catch (e) {
      throw new Error(
        `OpenTable ${serialised.method} ${path} — response was not JSON: ${String(
          (e as Error).message
        )}`
      );
    }
  }

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    throw new Error(
      `OpenTable API error: ${result.status} for ${method} ${path}`
    );
  }

  private throwIfSignInPage(result: FetchResult): void {
    const signInMarkers = [
      '/authenticate/start',
      'continue-with-email-button',
      'header-sign-in-button',
    ];
    const looksLikeSignIn =
      result.url.includes('/authenticate/') ||
      signInMarkers.some((m) => result.body.includes(m) && result.body.length < 80_000);
    if (looksLikeSignIn) throw new SessionNotAuthenticatedError();
  }
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run tests/client.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "$(cat <<'EOF'
feat(server): rewrite OpenTableClient around WS

Drops the cycletls transport. Client now owns an OpenTableWsServer,
exposes fetchHtml(path) for SSR page fetches and fetchJson(path, init)
for write endpoints. SessionNotAuthenticatedError is thrown when a
response looks like the sign-in page, so tools fail with an
actionable error instead of silently parsing the wrong HTML.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Remove cycletls artifacts

**Files:**
- Delete: `scripts/setup-auth.mjs`
- Delete: `scripts/e2e-phase1.ts`
- Modify: `.env.example`
- Modify: `package.json` (remove `cycletls`, remove `auth` + `smoke` scripts)

- [ ] **Step 1: Delete the scripts**

```bash
rm scripts/setup-auth.mjs scripts/e2e-phase1.ts
```

- [ ] **Step 2: Clear `.env.example`**

Replace the entire contents of `.env.example` with:
```
# v0.3+ requires no environment variables. The companion Chrome extension
# (see README → "Install the companion extension") holds the OpenTable
# session. This file is kept as a marker so tooling recognises the repo.
```

- [ ] **Step 3: Uninstall cycletls, remove its entry from package.json**

```bash
npm uninstall cycletls
```

Then edit `package.json` `"scripts"`: remove the `"smoke"` and `"auth"` entries; they reference deleted files. Leave `build`, `bundle`, `dev`, `test`, `test:watch`, `test:coverage` in place.

- [ ] **Step 4: Verify the suite still builds and tests still pass**

Run: `npm run build && npm test`
Expected: build clean, all existing tests pass (no tests referenced the deleted scripts).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: drop cycletls transport and its setup artifacts

v0.3 replaces the cookie+cycletls flow with the companion Chrome
extension. setup-auth.mjs and e2e-phase1.ts are no longer needed.
.env.example is emptied (no env vars required). cycletls uninstalled.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire `src/index.ts` and register the three existing tools

On this branch, `src/index.ts` still registers only the three v0.2 tools, but does so using the old client API. We update it to the new client shape (`start`/`close`) and keep just those three registered for Phase A.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace `src/index.ts`**

```ts
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpenTableClient } from './client.js';
import { registerReservationTools } from './tools/reservations.js';
import { registerUserTools } from './tools/user.js';
import { registerFavoriteTools } from './tools/favorites.js';

const client = new OpenTableClient();
await client.start();

const server = new McpServer({ name: 'opentable-mcp', version: '0.3.0-alpha.1' });

registerReservationTools(server, client);
registerUserTools(server, client);
registerFavoriteTools(server, client);

console.error(
  '[opentable-mcp] v0.3.0-alpha.1 — WebSocket bridge to Chrome extension on 127.0.0.1:37149. ' +
    'Load the extension from ./extension/ and sign in at opentable.com.'
);

const shutdown = async () => {
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Run full suite**

Run: `npm test`
Expected: all prior tests pass (the tool files import `OpenTableClient`; the type/API surface is preserved).

- [ ] **Step 3: Build and verify the bundle**

Run: `npm run build`
Expected: `dist/bundle.js` created, no TS errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat: wire index.ts for v0.3 — start the WS server on launch

Boots the OpenTableClient (which starts the WS server) before registering
tools. Version bumped to 0.3.0-alpha.1. Banner updated to reference the
extension install step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Phase A live verification (manual)

Confirm the extension + MCP server round-trip actually works end-to-end against real OpenTable for the existing 3 tools.

- [ ] **Step 1: Load the extension**

- `chrome://extensions` → enable Developer mode (top-right).
- "Load unpacked" → select the `extension/` directory in this repo.
- Extension icon appears in the toolbar. Click it → popup shows WS red (server not running yet).

- [ ] **Step 2: Start the MCP server**

Run (in one terminal):
```bash
npm run build && node dist/bundle.js
```
Expected banner: `v0.3.0-alpha.1 — WebSocket bridge to Chrome extension on 127.0.0.1:37149`.

- [ ] **Step 3: Verify handshake**

- Click the extension icon. WS dot goes green within 1-2s.
- A new pinned tab opens at opentable.com (or reuses an existing one). Tab dot goes green.
- If you're not signed in, auth dot is red — sign in via email OTP, then the dot goes green.

- [ ] **Step 4: Smoke-test the three tools via MCP Inspector or a direct tools/list + tools/call**

The simplest: use the MCP SDK's in-process client from a throwaway TS script.

Write `scripts/e2e-phase-a.ts`:
```ts
#!/usr/bin/env tsx
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 't', version: '0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/bundle.js'],
});
await client.connect(transport);

for (const name of ['opentable_list_reservations', 'opentable_get_profile', 'opentable_list_favorites']) {
  const result = await client.callTool({ name, arguments: {} });
  const text = (result.content[0] as { text: string }).text;
  const parsed = JSON.parse(text);
  const summary = Array.isArray(parsed) ? `${parsed.length} entries` : Object.keys(parsed).join(',');
  console.log(`${name}: ${summary}`);
}
await client.close();
```

Run: `npx tsx scripts/e2e-phase-a.ts`
Expected output similar to:
```
opentable_list_reservations: 1 entries
opentable_get_profile: first_name,last_name,email,...
opentable_list_favorites: 0 entries
```

- [ ] **Step 5: Commit the e2e script**

```bash
git add scripts/e2e-phase-a.ts
git commit -m "$(cat <<'EOF'
test: add phase A e2e script — exercises the 3 existing tools via MCP SDK

Spawns dist/bundle.js as a child process, connects via stdio, calls
each of list_reservations / get_profile / list_favorites, prints a
one-line shape summary. Replaces the v0.2 e2e-phase1.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Re-register search + get_restaurant (Phase B)

Phase B is trivial: the parsers, tools, and tests all exist from v0.2. We only re-register them.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update `src/index.ts`**

Replace the current imports + registrations block:

```ts
import { OpenTableClient } from './client.js';
import { registerReservationTools } from './tools/reservations.js';
import { registerUserTools } from './tools/user.js';
import { registerFavoriteTools } from './tools/favorites.js';
```

with:

```ts
import { OpenTableClient } from './client.js';
import { registerReservationTools } from './tools/reservations.js';
import { registerUserTools } from './tools/user.js';
import { registerFavoriteTools } from './tools/favorites.js';
import { registerSearchTools } from './tools/search.js';
import { registerRestaurantTools } from './tools/restaurants.js';
```

and the registrations:
```ts
registerReservationTools(server, client);
registerUserTools(server, client);
registerFavoriteTools(server, client);
```

with:
```ts
registerReservationTools(server, client);
registerUserTools(server, client);
registerFavoriteTools(server, client);
registerSearchTools(server, client);
registerRestaurantTools(server, client);
```

- [ ] **Step 2: Run the suite**

Run: `npm test`
Expected: all existing tests pass (52 → still 52; those tools' tests were never removed).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Live verify via MCP Inspector or an expanded e2e-phase-a.ts**

With the MCP server still running and the extension connected, call:
```ts
const search = await client.callTool({
  name: 'opentable_search_restaurants',
  arguments: { term: 'italian', location: 'Charlotte', date: '2026-05-01', party_size: 2 }
});
```
Expected: `result.restaurants.length` > 0.

```ts
const detail = await client.callTool({
  name: 'opentable_get_restaurant',
  arguments: { restaurant_id: 'gran-morsi-new-york' }
});
```
Expected: non-empty `name`, `primary_cuisine`, `address`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat: register search_restaurants + get_restaurant (phase B)

Parsers and tool code have been in the repo since v0.2 but were
unregistered because cycletls couldn't reach the pages. The extension
transport unblocks both. Tool count: 3 → 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: XHR logger in the content script (Phase C foundation)

Add an XHR logger to the content script so we can capture the 5 unknown endpoint shapes during Phase C's manual discovery pass.

**Files:**
- Modify: `extension/content.js`

- [ ] **Step 1: Append to `extension/content.js`**

Add at the end of the file:

```js
// ─── XHR logger for endpoint discovery (v0.3 Phase C) ────────────────
// Captures every POST/PUT/DELETE to opentable.com/dapi/* or /dtp/* and
// stashes { url, method, headers, body, status, responseBody } into
// window.__otMcpCaptures. Use chrome devtools console to read:
//    copy(JSON.stringify(window.__otMcpCaptures, null, 2))
// then paste into the relevant discovery file.

(function installCaptureLogger() {
  const CAPTURES = (window.__otMcpCaptures = window.__otMcpCaptures || []);
  const MATCHERS = [/\/dapi\//, /\/dtp\//, /\/restref\//];

  function shouldCapture(url, method) {
    if (!url.includes('opentable.com')) return false;
    if (method === 'GET') return false;
    return MATCHERS.some((re) => re.test(url));
  }

  // Patch window.fetch
  const origFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const reqHeaders = init.headers ?? {};
    const reqBody = typeof init.body === 'string' ? init.body : null;
    const start = Date.now();
    const response = await origFetch.call(this, input, init);
    if (shouldCapture(url, method)) {
      try {
        const cloned = response.clone();
        const responseBody = await cloned.text();
        CAPTURES.push({
          at: new Date().toISOString(),
          durMs: Date.now() - start,
          url,
          method,
          headers: reqHeaders,
          body: reqBody,
          status: response.status,
          responseBody: responseBody.slice(0, 50_000),
        });
      } catch {
        /* ignore */
      }
    }
    return response;
  };

  // Patch XMLHttpRequest.send
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__otMcpMethod = (method || 'GET').toUpperCase();
    this.__otMcpUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const captured = shouldCapture(this.__otMcpUrl ?? '', this.__otMcpMethod ?? 'GET');
    if (captured) {
      this.addEventListener('loadend', () => {
        CAPTURES.push({
          at: new Date().toISOString(),
          url: this.__otMcpUrl,
          method: this.__otMcpMethod,
          body: typeof body === 'string' ? body : null,
          status: this.status,
          responseBody: (this.responseText ?? '').slice(0, 50_000),
        });
      });
    }
    return origSend.apply(this, arguments);
  };
})();
```

- [ ] **Step 2: Commit**

```bash
git add extension/content.js
git commit -m "$(cat <<'EOF'
extension: add XHR/fetch logger for endpoint discovery

Patches window.fetch and XMLHttpRequest.send to record every non-GET
call against opentable.com's /dapi, /dtp, and /restref paths into
window.__otMcpCaptures. Used during Phase C manual discovery — user
performs an action (reserve, cancel, favorite) in the pinned tab,
then copies captures via the devtools console into a discovery doc.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Phase C discovery pass (manual)

This task captures the 5 unknown endpoint shapes. No code to write yet — the output is a document and a set of TypeScript constants that later tasks use.

**Output file:**
- Create: `docs/superpowers/notes/endpoint-captures.md` (redacted captures — no PII)
- Create: `src/endpoint-templates.ts` (sanitised TS constants: URL, method, required headers, body shape)

Each of the five sub-steps uses the XHR logger installed in Task 11. Reload the pinned opentable.com tab AFTER loading the extension so the logger installs.

- [ ] **Step 1: Capture `RestaurantsAvailability` (for `find_slots`)**

1. In the pinned tab, navigate to any restaurant profile with a dateTime query: `https://www.opentable.com/r/gran-morsi-new-york?dateTime=2026-05-01T19:00&covers=2`.
2. Wait ~5s for availability to load.
3. DevTools → Console:
   ```js
   copy(JSON.stringify(window.__otMcpCaptures.filter(c => c.url.includes('RestaurantsAvailability')), null, 2))
   ```
4. Paste clipboard into a new temp file.
5. Extract the captured POST body — the `operationName`, `query` (full GraphQL text), and `variables` shape. Extract the response structure (`data.multiSearch.restaurants[].availability` or wherever slots live — inspect).

Record in `docs/superpowers/notes/endpoint-captures.md`:
- URL (`https://www.opentable.com/dapi/fe/gql?optype=query&opname=RestaurantsAvailability`)
- Required headers (including any `x-csrf-token`)
- `variables` shape for input
- Response shape for the parser
- **Redact all numeric venue IDs / coordinates / auth tokens** — leave only the schema.

- [ ] **Step 2: Capture Reserve / book**

1. In the pinned tab, go through a booking flow up to the point where you'd submit. DO NOT complete — the tab's "Complete reservation" button triggers the real POST. Instead, click it and immediately capture (the reservation may or may not go through; pick a tomorrow slot you're willing to cancel, or use a time you actually want).
2. Capture as in Step 1, filtering captures for the POST that contains `securityToken` / `book` / `reservation` hints.
3. Record URL, method, headers (especially csrf), body shape, response shape (confirmation number, reservation id, etc.).

If the booking is real, cancel it immediately afterwards so you can also capture the cancel in Step 3.

- [ ] **Step 3: Capture Cancel**

1. Go to Dining Dashboard → click an upcoming reservation → click Cancel.
2. Filter captures for the cancel POST.
3. Record URL, method, headers, body shape, response shape.

- [ ] **Step 4: Capture Add Favorite (heart icon click)**

1. Navigate to any restaurant profile. Click the heart / "save" icon.
2. Filter captures for the POST that saves the favorite.
3. Record URL, method, body shape (probably `{restaurantId}` or URL-embedded id).

- [ ] **Step 5: Capture Remove Favorite**

1. On the same (or any) saved restaurant, click the heart again to un-save.
2. Filter, record as before.

- [ ] **Step 6: Write `src/endpoint-templates.ts`**

```ts
/**
 * Captured OpenTable endpoint templates.
 *
 * Each constant below was observed in the live web app during the v0.3
 * Phase C discovery pass. See `docs/superpowers/notes/endpoint-captures.md`
 * for the raw (redacted) captures that these are derived from.
 *
 * If OpenTable changes an endpoint, the corresponding tool's live tests
 * will break with a parse error or non-2xx — re-run the discovery
 * procedure for that tool and update this file.
 */

export const GRAPHQL_AVAILABILITY = {
  path: '/dapi/fe/gql?optype=query&opname=RestaurantsAvailability',
  method: 'POST' as const,
  // TODO during discovery: paste the exact query string captured.
  query: /* captured GraphQL doc — fill in during Step 1 above */ '',
  // operationName is also 'RestaurantsAvailability'.
  // Input variables shape — fill in the exact keys captured:
  //   { restaurantIds: number[], partySize: number, dateTime: string, ... }
};

export const BOOK_ENDPOINT = {
  path: '' /* captured path, e.g. /dtp/eatery/reserve */,
  method: 'POST' as const,
  // Body shape — fill in.
};

export const CANCEL_ENDPOINT = {
  // /dtp/eatery/reservation/{confirmationNumber}/cancel (candidate) — confirm.
  pathTemplate: '' /* fill in, using ${} placeholders */,
  method: 'POST' as const,
};

export const ADD_FAVORITE_ENDPOINT = {
  pathTemplate: '' /* fill in */,
  method: 'POST' as const,
};

export const REMOVE_FAVORITE_ENDPOINT = {
  pathTemplate: '' /* fill in */,
  method: 'DELETE' as const,
};
```

After capturing, replace each TODO/blank with the real value. The engineer executing this task **must** check that each captured URL, method, and body shape is recorded here verbatim (modulo stringifying auth tokens / IDs).

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/notes/endpoint-captures.md src/endpoint-templates.ts
git commit -m "$(cat <<'EOF'
docs+chore: capture five endpoint templates for v0.3 phase D/E

Phase C manual pass: performed each action (availability load, book,
cancel, favorite, unfavorite) in the pinned tab; captured the outgoing
XHR via the content-script logger; redacted PII; transcribed the URL,
method, headers, body shape, and response shape into
endpoint-captures.md. src/endpoint-templates.ts has the distilled
constants that Tasks 13-17 import from.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: `parse-slots.ts` + `find_slots` tool (TDD)

**Files:**
- Create: `src/parse-slots.ts`
- Create: `tests/parse-slots.test.ts`
- Modify: `src/tools/reservations.ts` (add `find_slots`)
- Modify: `tests/tools/reservations.test.ts` (add tests)

- [ ] **Step 1: Write failing tests for the parser**

```ts
// tests/parse-slots.test.ts
import { describe, it, expect } from 'vitest';
import { parseAvailabilityResponse } from '../src/parse-slots.js';

// Synthetic fixture matching the shape captured during Phase C.
const sampleResponse = {
  data: {
    multiSearch: {
      restaurants: [
        {
          restaurantId: 42,
          availability: [
            { token: 'tok-19', time: '19:00', type: 'Dining Room' },
            { token: 'tok-1930', time: '19:30', type: 'Dining Room' },
            { token: 'tok-2000', time: '20:00', type: 'Bar' },
          ],
          __typename: 'RestaurantAvailability',
        },
      ],
    },
  },
};

describe('parseAvailabilityResponse', () => {
  it('returns slots sorted by time ascending', () => {
    const slots = parseAvailabilityResponse(sampleResponse, '2026-05-01', 2);
    expect(slots).toEqual([
      { reservation_token: 'tok-19', date: '2026-05-01', time: '19:00', party_size: 2, type: 'Dining Room' },
      { reservation_token: 'tok-1930', date: '2026-05-01', time: '19:30', party_size: 2, type: 'Dining Room' },
      { reservation_token: 'tok-2000', date: '2026-05-01', time: '20:00', party_size: 2, type: 'Bar' },
    ]);
  });

  it('returns an empty array when no restaurants are in the response', () => {
    expect(
      parseAvailabilityResponse({ data: { multiSearch: { restaurants: [] } } }, '2026-05-01', 2)
    ).toEqual([]);
  });

  it('handles missing availability field', () => {
    expect(
      parseAvailabilityResponse(
        { data: { multiSearch: { restaurants: [{ restaurantId: 1 }] } } },
        '2026-05-01',
        2
      )
    ).toEqual([]);
  });

  it('throws on unrecognised response shape', () => {
    expect(() => parseAvailabilityResponse({}, '2026-05-01', 2)).toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/parse-slots.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/parse-slots.ts`**

```ts
export interface FormattedSlot {
  reservation_token: string;
  date: string;
  time: string;
  party_size: number;
  type?: string;
}

interface RawSlot {
  token?: string;
  time?: string;
  type?: string;
}

interface RawAvailabilityResponse {
  data?: {
    multiSearch?: {
      restaurants?: Array<{
        restaurantId?: number;
        availability?: RawSlot[];
      }>;
    };
  };
  errors?: unknown;
}

function compareHHMM(a: string, b: string): number {
  const p = (s: string) => {
    const [h, m] = s.split(':').map((n) => Number(n));
    return (h || 0) * 60 + (m || 0);
  };
  return p(a) - p(b);
}

export function parseAvailabilityResponse(
  raw: unknown,
  date: string,
  partySize: number
): FormattedSlot[] {
  const r = raw as RawAvailabilityResponse;
  if (r?.errors) {
    throw new Error(`OpenTable availability response contained errors: ${JSON.stringify(r.errors)}`);
  }
  const restaurants = r?.data?.multiSearch?.restaurants;
  if (!Array.isArray(restaurants)) {
    throw new Error('Unrecognised availability response shape — data.multiSearch.restaurants missing');
  }
  const all: FormattedSlot[] = [];
  for (const r0 of restaurants) {
    for (const s of r0.availability ?? []) {
      all.push({
        reservation_token: s.token ?? '',
        date,
        time: s.time ?? '',
        party_size: partySize,
        type: s.type,
      });
    }
  }
  return all.sort((a, b) => compareHHMM(a.time, b.time));
}
```

- [ ] **Step 4: Run parser tests — confirm pass**

Run: `npx vitest run tests/parse-slots.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Add `find_slots` tests in `tests/tools/reservations.test.ts`**

Append inside the outer `describe('reservation tools', ...)`:

```ts
  describe('opentable_find_slots', () => {
    it('POSTs the availability gql query and returns formatted slots', async () => {
      mockFetchJson.mockResolvedValue({
        data: {
          multiSearch: {
            restaurants: [
              {
                restaurantId: 42,
                availability: [
                  { token: 'a', time: '19:00', type: 'Dining Room' },
                  { token: 'b', time: '19:30', type: 'Dining Room' },
                ],
              },
            ],
          },
        },
      });
      const result = await harness.callTool('opentable_find_slots', {
        restaurant_id: 42,
        date: '2026-05-01',
        party_size: 2,
      });
      expect(mockFetchJson).toHaveBeenCalledWith(
        '/dapi/fe/gql?optype=query&opname=RestaurantsAvailability',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ variables: expect.objectContaining({ restaurantIds: [42], partySize: 2 }) }),
        })
      );
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].reservation_token).toBe('a');
    });
  });
```

Also add, near the top of `tests/tools/reservations.test.ts`, a `mockFetchJson = vi.fn()` and update `mockClient` to expose it:

```ts
const mockFetchHtml = vi.fn();
const mockFetchJson = vi.fn();
const mockClient = {
  fetchHtml: mockFetchHtml,
  fetchJson: mockFetchJson,
} as unknown as OpenTableClient;
```

- [ ] **Step 6: Run to confirm failure**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: the new `opentable_find_slots` test fails — tool not registered.

- [ ] **Step 7: Add the tool registration in `src/tools/reservations.ts`**

At the top of the file, add:
```ts
import { GRAPHQL_AVAILABILITY } from '../endpoint-templates.js';
import { parseAvailabilityResponse } from '../parse-slots.js';
```

Inside `registerReservationTools`, after the existing `opentable_list_reservations` registration, add:

```ts
  server.registerTool(
    'opentable_find_slots',
    {
      description:
        'List available reservation slots at a specific OpenTable restaurant for a given date + party size. Tokens expire quickly; call opentable_book soon after.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        restaurant_id: z.number().int().positive(),
        date: z.string().describe('YYYY-MM-DD'),
        party_size: z.number().int().positive(),
        time: z.string().optional().describe('HH:MM (24h) — narrows the response'),
      },
    },
    async ({ restaurant_id, date, party_size, time }) => {
      const dateTime = `${date}T${time ?? '19:00'}:00`;
      const response = await client.fetchJson<unknown>(GRAPHQL_AVAILABILITY.path, {
        method: 'POST',
        body: {
          operationName: 'RestaurantsAvailability',
          query: GRAPHQL_AVAILABILITY.query,
          variables: {
            restaurantIds: [restaurant_id],
            partySize: party_size,
            dateTime,
          },
        },
      });
      const slots = parseAvailabilityResponse(response, date, party_size);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(slots, null, 2) }],
      };
    }
  );
```

- [ ] **Step 8: Run tool tests — confirm pass**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: all tests pass (existing + new `find_slots`).

- [ ] **Step 9: Register the tool in `src/index.ts`**

`find_slots` is inside `registerReservationTools`, already called — nothing to add in index.ts.

- [ ] **Step 10: Live-verify via MCP client**

With the MCP server + extension running, call:
```ts
await client.callTool({
  name: 'opentable_find_slots',
  arguments: { restaurant_id: 42, date: '2026-05-01', party_size: 2 }
});
```
Use a `restaurant_id` you got from `opentable_search_restaurants`. Expected: an array of `{reservation_token, date, time, ...}`.

- [ ] **Step 11: Commit**

```bash
git add src/parse-slots.ts tests/parse-slots.test.ts src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "$(cat <<'EOF'
feat(tools): add find_slots via the RestaurantsAvailability gql query

Parser lives in src/parse-slots.ts; synthetic-fixture tests cover the
sorted-by-time case, missing-availability case, and the error case.
Tool POSTs the captured query (see endpoint-templates.ts) through the
extension and pipes the response to the parser.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: `opentable_book` (TDD)

**Files:**
- Create: `src/parse-book-response.ts`
- Create: `tests/parse-book-response.test.ts`
- Modify: `src/tools/reservations.ts`
- Modify: `tests/tools/reservations.test.ts`

- [ ] **Step 1: Write failing tests for the parser**

```ts
// tests/parse-book-response.test.ts
import { describe, it, expect } from 'vitest';
import { parseBookResponse } from '../src/parse-book-response.js';

// Shape from the Phase C discovery capture (placeholder until real capture):
const sample = {
  confirmationNumber: 1234567890,
  reservationId: 'res-abc',
  securityToken: 'tok-security',
  restaurantName: 'Testeria',
  dateTime: '2026-05-01T19:00:00',
  partySize: 2,
  state: 'CONFIRMED',
};

describe('parseBookResponse', () => {
  it('maps the confirmation payload to our formatted shape', () => {
    const r = parseBookResponse(sample);
    expect(r).toEqual({
      confirmation_number: 1234567890,
      reservation_id: 'res-abc',
      security_token: 'tok-security',
      restaurant_name: 'Testeria',
      date: '2026-05-01',
      time: '19:00',
      party_size: 2,
      status: 'CONFIRMED',
    });
  });

  it('throws when the response contains an error code', () => {
    expect(() => parseBookResponse({ errorCode: 'SLOT_TAKEN', errorMessage: 'Slot no longer available' })).toThrow(
      /SLOT_TAKEN/
    );
  });

  it('throws when confirmationNumber is absent', () => {
    expect(() => parseBookResponse({ restaurantName: 'X' })).toThrow(/confirmation/i);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/parse-book-response.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/parse-book-response.ts`**

```ts
export interface FormattedBooking {
  confirmation_number: number;
  reservation_id: string;
  security_token: string;
  restaurant_name: string;
  date: string;
  time: string;
  party_size: number;
  status: string;
}

interface RawBookResponse {
  confirmationNumber?: number;
  reservationId?: string;
  securityToken?: string;
  restaurantName?: string;
  dateTime?: string;
  partySize?: number;
  state?: string;
  errorCode?: string;
  errorMessage?: string;
}

function splitDateTime(dt: string | undefined): { date: string; time: string } {
  if (!dt) return { date: '', time: '' };
  const t = dt.indexOf('T');
  if (t < 0) return { date: dt, time: '' };
  const rest = dt.slice(t + 1);
  const hhmm = rest.match(/^(\d{2}):(\d{2})/);
  return { date: dt.slice(0, t), time: hhmm ? `${hhmm[1]}:${hhmm[2]}` : '' };
}

export function parseBookResponse(raw: unknown): FormattedBooking {
  const r = raw as RawBookResponse;
  if (r?.errorCode) {
    throw new Error(`OpenTable book error: ${r.errorCode}${r.errorMessage ? ` — ${r.errorMessage}` : ''}`);
  }
  if (r?.confirmationNumber === undefined || r?.confirmationNumber === null) {
    throw new Error('Book response missing confirmationNumber');
  }
  const { date, time } = splitDateTime(r.dateTime);
  return {
    confirmation_number: r.confirmationNumber,
    reservation_id: r.reservationId ?? '',
    security_token: r.securityToken ?? '',
    restaurant_name: r.restaurantName ?? '',
    date,
    time,
    party_size: r.partySize ?? 0,
    status: r.state ?? '',
  };
}
```

- [ ] **Step 4: Run parser tests — confirm pass**

Run: `npx vitest run tests/parse-book-response.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Add `book` tool tests in `tests/tools/reservations.test.ts`**

Append:

```ts
  describe('opentable_book', () => {
    it('POSTs to the book endpoint with the slot token + requests', async () => {
      mockFetchJson.mockResolvedValue({
        confirmationNumber: 99,
        reservationId: 'r-99',
        securityToken: 's-99',
        restaurantName: 'Testeria',
        dateTime: '2026-05-01T19:00:00',
        partySize: 2,
        state: 'CONFIRMED',
      });
      const result = await harness.callTool('opentable_book', {
        reservation_token: 'tok-abc',
        restaurant_id: 42,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
        special_requests: 'Window seat',
      });
      expect(mockFetchJson).toHaveBeenCalledWith(
        expect.any(String), // URL from endpoint-templates
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            slotToken: 'tok-abc',
            partySize: 2,
            specialRequests: 'Window seat',
          }),
        })
      );
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.confirmation_number).toBe(99);
    });

    it('surfaces the OpenTable error code when booking fails', async () => {
      mockFetchJson.mockResolvedValue({
        errorCode: 'SLOT_TAKEN',
        errorMessage: 'Slot no longer available',
      });
      const result = await harness.callTool('opentable_book', {
        reservation_token: 'tok-abc',
        restaurant_id: 42,
        date: '2026-05-01',
        time: '19:00',
        party_size: 2,
      });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/SLOT_TAKEN/);
    });
  });
```

- [ ] **Step 6: Run to confirm failure**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: 2 new tests fail — `opentable_book` not registered.

- [ ] **Step 7: Add the `book` tool in `src/tools/reservations.ts`**

At the top (next to existing imports), add:
```ts
import { BOOK_ENDPOINT } from '../endpoint-templates.js';
import { parseBookResponse } from '../parse-book-response.js';
```

Append inside `registerReservationTools` (after `find_slots`):

```ts
  server.registerTool(
    'opentable_book',
    {
      description:
        'Book an OpenTable reservation using a fresh reservation_token obtained from opentable_find_slots. Pass special_requests (e.g. dietary notes, window seat) if any. Tokens expire quickly — find and book in the same turn.',
      inputSchema: {
        reservation_token: z.string(),
        restaurant_id: z.number().int().positive(),
        date: z.string().describe('YYYY-MM-DD'),
        time: z.string().describe('HH:MM (24h)'),
        party_size: z.number().int().positive(),
        special_requests: z.string().optional(),
      },
    },
    async ({ reservation_token, restaurant_id, date, time, party_size, special_requests }) => {
      const response = await client.fetchJson<unknown>(BOOK_ENDPOINT.path, {
        method: BOOK_ENDPOINT.method,
        body: {
          slotToken: reservation_token,
          restaurantId: restaurant_id,
          dateTime: `${date}T${time}:00`,
          partySize: party_size,
          specialRequests: special_requests,
        },
      });
      const booking = parseBookResponse(response);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(booking, null, 2) }],
      };
    }
  );
```

- [ ] **Step 8: Run tool tests — confirm pass**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: all tests pass.

- [ ] **Step 9: Live verify carefully**

`book` is a write operation — if you run this against live OpenTable, you will make a real reservation. Pick a restaurant + slot you're willing to follow through on, or immediately cancel via the tool in Task 15 after booking.

```ts
const slots = await client.callTool({
  name: 'opentable_find_slots',
  arguments: { restaurant_id: <id from search>, date: 'YYYY-MM-DD', party_size: 2 }
});
const token = JSON.parse(slots.content[0].text)[0].reservation_token;
const booking = await client.callTool({
  name: 'opentable_book',
  arguments: { reservation_token: token, restaurant_id: <id>, date: 'YYYY-MM-DD', time: 'HH:MM', party_size: 2 }
});
```
Expected: `confirmation_number` numeric, `security_token` non-empty.

- [ ] **Step 10: Commit**

```bash
git add src/parse-book-response.ts tests/parse-book-response.test.ts src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "$(cat <<'EOF'
feat(tools): add book — POSTs to captured book endpoint with slot token

Parser handles the confirmation shape + OpenTable error codes. Tool
accepts a reservation_token from find_slots and books the specified
slot with optional special_requests. Live-verified against a real
account.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: `opentable_cancel` (TDD)

**Files:**
- Modify: `src/tools/reservations.ts`
- Modify: `tests/tools/reservations.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/tools/reservations.test.ts`:

```ts
  describe('opentable_cancel', () => {
    it('POSTs with the security_token to the captured cancel endpoint', async () => {
      mockFetchJson.mockResolvedValue({ state: 'CANCELLED' });
      const result = await harness.callTool('opentable_cancel', {
        confirmation_number: 123,
        security_token: 'tok-sec',
      });
      expect(mockFetchJson).toHaveBeenCalledWith(
        expect.stringContaining('123'),
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ securityToken: 'tok-sec' }),
        })
      );
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.cancelled).toBe(true);
    });

    it('reports cancelled=false on explicit errorCode', async () => {
      mockFetchJson.mockResolvedValue({ errorCode: 'ALREADY_CANCELLED' });
      const result = await harness.callTool('opentable_cancel', {
        confirmation_number: 123,
        security_token: 'tok-sec',
      });
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.cancelled).toBe(false);
      expect(parsed.raw.errorCode).toBe('ALREADY_CANCELLED');
    });
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: 2 new tests fail — `opentable_cancel` not registered.

- [ ] **Step 3: Implement the tool**

In `src/tools/reservations.ts`, at the top alongside other imports:
```ts
import { CANCEL_ENDPOINT } from '../endpoint-templates.js';
```

Append inside `registerReservationTools` (after `book`):

```ts
  server.registerTool(
    'opentable_cancel',
    {
      description:
        'Cancel an OpenTable reservation. Requires confirmation_number and security_token from opentable_list_reservations or opentable_book.',
      inputSchema: {
        confirmation_number: z.number().int().positive(),
        security_token: z.string(),
      },
    },
    async ({ confirmation_number, security_token }) => {
      const path = CANCEL_ENDPOINT.pathTemplate.replace(
        '${confirmationNumber}',
        String(confirmation_number)
      );
      const data = await client.fetchJson<Record<string, unknown>>(path, {
        method: CANCEL_ENDPOINT.method,
        body: { securityToken: security_token },
      });
      const state = typeof data.state === 'string' ? data.state.toLowerCase() : '';
      const hasError = 'errorCode' in data || 'errorMessage' in data;
      const cancelled = /cancel/i.test(state) && !hasError;
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ cancelled, raw: data }, null, 2) },
        ],
      };
    }
  );
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run tests/tools/reservations.test.ts`
Expected: all pass.

- [ ] **Step 5: Live verify** (only if you have a cancelable reservation)

```ts
await client.callTool({
  name: 'opentable_cancel',
  arguments: { confirmation_number: <n>, security_token: '<s>' }
});
```
Expected: `{ cancelled: true, raw: {...} }`.

- [ ] **Step 6: Commit**

```bash
git add src/tools/reservations.ts tests/tools/reservations.test.ts
git commit -m "$(cat <<'EOF'
feat(tools): add cancel — POSTs securityToken to captured cancel endpoint

Uses the raw 'state' field + absence of errorCode to determine
cancelled=true/false, with the full raw response passed through for
transparency (same pattern as v0.1.0's resy-style cancel).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: `opentable_add_favorite` + `opentable_remove_favorite` (TDD)

**Files:**
- Modify: `src/tools/favorites.ts`
- Modify: `tests/tools/favorites.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/tools/favorites.test.ts`:

```ts
  it('add_favorite POSTs the restaurant id to the captured endpoint', async () => {
    mockFetchJson.mockResolvedValue({ ok: true });
    const result = await harness.callTool('opentable_add_favorite', {
      restaurant_id: 42,
    });
    expect(mockFetchJson).toHaveBeenCalledWith(
      expect.stringContaining('42'),
      expect.objectContaining({ method: 'POST' })
    );
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({ favorited: true, restaurant_id: 42 });
  });

  it('remove_favorite DELETEs and reports removed=true', async () => {
    mockFetchJson.mockResolvedValue({ ok: true });
    const result = await harness.callTool('opentable_remove_favorite', {
      restaurant_id: 42,
    });
    expect(mockFetchJson).toHaveBeenCalledWith(
      expect.stringContaining('42'),
      expect.objectContaining({ method: 'DELETE' })
    );
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({ removed: true, restaurant_id: 42 });
  });
```

Also, near the top of `tests/tools/favorites.test.ts`, update the mock client to expose `fetchJson`:
```ts
const mockFetchHtml = vi.fn();
const mockFetchJson = vi.fn();
const mockClient = {
  fetchHtml: mockFetchHtml,
  fetchJson: mockFetchJson,
} as unknown as OpenTableClient;
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/tools/favorites.test.ts`
Expected: 2 new tests fail.

- [ ] **Step 3: Implement the tools**

At the top of `src/tools/favorites.ts` add:
```ts
import { z } from 'zod';
import { ADD_FAVORITE_ENDPOINT, REMOVE_FAVORITE_ENDPOINT } from '../endpoint-templates.js';
```
(`z` may already be imported — no duplicates.)

Append inside `registerFavoriteTools`:

```ts
  server.registerTool(
    'opentable_add_favorite',
    {
      description: 'Add an OpenTable restaurant to the saved-restaurants list.',
      inputSchema: { restaurant_id: z.number().int().positive() },
    },
    async ({ restaurant_id }) => {
      const path = ADD_FAVORITE_ENDPOINT.pathTemplate.replace(
        '${restaurantId}',
        String(restaurant_id)
      );
      await client.fetchJson<unknown>(path, {
        method: ADD_FAVORITE_ENDPOINT.method,
        body: {},
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ favorited: true, restaurant_id }, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    'opentable_remove_favorite',
    {
      description: 'Remove an OpenTable restaurant from the saved-restaurants list.',
      inputSchema: { restaurant_id: z.number().int().positive() },
    },
    async ({ restaurant_id }) => {
      const path = REMOVE_FAVORITE_ENDPOINT.pathTemplate.replace(
        '${restaurantId}',
        String(restaurant_id)
      );
      await client.fetchJson<unknown>(path, {
        method: REMOVE_FAVORITE_ENDPOINT.method,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ removed: true, restaurant_id }, null, 2) },
        ],
      };
    }
  );
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run tests/tools/favorites.test.ts`
Expected: all pass.

- [ ] **Step 5: Live verify**

```ts
await client.callTool({ name: 'opentable_add_favorite', arguments: { restaurant_id: 42 } });
const list = await client.callTool({ name: 'opentable_list_favorites' });
// expect parsed list to include 42
await client.callTool({ name: 'opentable_remove_favorite', arguments: { restaurant_id: 42 } });
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/favorites.ts tests/tools/favorites.test.ts
git commit -m "$(cat <<'EOF'
feat(tools): add add_favorite + remove_favorite

Both tools consume restaurant_id and hit the captured endpoints in
endpoint-templates.ts. Return { favorited/removed: true, restaurant_id }
on success. Live-verified via list_favorites round-trip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Full e2e script

**Files:**
- Create: `scripts/e2e-all.ts`
- Modify: `package.json` (add `smoke` script pointing at it)

- [ ] **Step 1: Write `scripts/e2e-all.ts`**

```ts
#!/usr/bin/env tsx
/**
 * Full end-to-end for v0.3. Requires:
 *   - MCP server running in another process (npm run dev).
 *   - Chrome with the companion extension loaded and signed in.
 *
 * Exercises all 10 tools once each with redacted output (no PII).
 * Does NOT attempt opentable_book or opentable_cancel by default; pass
 * `--write` to also exercise the write tools (creates + cancels a real
 * reservation — pick your test venue carefully).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXERCISE_WRITES = process.argv.includes('--write');

const client = new Client({ name: 'e2e-all', version: '0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/bundle.js'],
});
await client.connect(transport);

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content[0] as { text: string }).text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summary(obj: unknown): string {
  if (Array.isArray(obj)) return `[${obj.length}]`;
  if (obj && typeof obj === 'object') return `{${Object.keys(obj).length} keys}`;
  return typeof obj;
}

const profile = await call('opentable_get_profile');
console.log('get_profile:', summary(profile));

const upcoming = await call('opentable_list_reservations', { scope: 'upcoming' });
const past = await call('opentable_list_reservations', { scope: 'past' });
console.log(`list_reservations: upcoming=${summary(upcoming)} past=${summary(past)}`);

const favs = await call('opentable_list_favorites');
console.log('list_favorites:', summary(favs));

const search = await call('opentable_search_restaurants', {
  term: 'italian',
  location: 'Charlotte',
  date: '2026-05-01',
  party_size: 2,
});
console.log('search_restaurants:', summary(search));

if (Array.isArray(search.restaurants) && search.restaurants.length > 0) {
  const firstId = search.restaurants[0].restaurant_id;
  if (typeof firstId === 'number' || typeof firstId === 'string') {
    const detail = await call('opentable_get_restaurant', { restaurant_id: firstId });
    console.log('get_restaurant:', summary(detail));

    const slots = await call('opentable_find_slots', {
      restaurant_id: Number(firstId),
      date: '2026-05-01',
      party_size: 2,
    });
    console.log('find_slots:', summary(slots));

    if (EXERCISE_WRITES && Array.isArray(slots) && slots.length > 0) {
      const slot = slots[0];
      const booking = await call('opentable_book', {
        reservation_token: slot.reservation_token,
        restaurant_id: Number(firstId),
        date: slot.date,
        time: slot.time,
        party_size: 2,
      });
      console.log('book:', summary(booking));

      if (booking?.confirmation_number && booking?.security_token) {
        const cancel = await call('opentable_cancel', {
          confirmation_number: booking.confirmation_number,
          security_token: booking.security_token,
        });
        console.log('cancel:', summary(cancel));
      }
    }

    if (EXERCISE_WRITES) {
      const addFav = await call('opentable_add_favorite', { restaurant_id: Number(firstId) });
      console.log('add_favorite:', summary(addFav));
      const remFav = await call('opentable_remove_favorite', { restaurant_id: Number(firstId) });
      console.log('remove_favorite:', summary(remFav));
    }
  }
}

await client.close();
```

- [ ] **Step 2: Add `smoke` npm script**

In `package.json` `"scripts"`, add:
```json
    "smoke": "npm run build && tsx scripts/e2e-all.ts",
```

- [ ] **Step 3: Run it (read-only mode)**

Run: `npm run smoke`
Expected: one line per tool, all with non-empty shapes. No `threw` or `error`.

- [ ] **Step 4: Commit**

```bash
git add scripts/e2e-all.ts package.json
git commit -m "$(cat <<'EOF'
test: add scripts/e2e-all.ts — exercises all 10 tools round-trip

npm run smoke builds + runs all read-only tools against a live
OpenTable session. --write flag additionally exercises book / cancel
and favorite add/remove (real mutations — use a test venue).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Update `manifest.json` (MCPB) + README + CLAUDE.md

**Files:**
- Modify: `manifest.json` (MCPB)
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update MCPB `manifest.json`**

Replace the whole file with:

```json
{
  "$schema": "https://raw.githubusercontent.com/anthropics/dxt/main/dist/mcpb-manifest.schema.json",
  "manifest_version": "0.3",
  "name": "opentable-mcp",
  "display_name": "OpenTable",
  "version": "0.3.0-alpha.1",
  "description": "OpenTable reservation management for Claude — search, book, cancel, list reservations, manage favorites. Backed by a companion Chrome extension that proxies requests through your signed-in OpenTable tab.",
  "author": {
    "name": "Chris Chall",
    "email": "chris.c.hall@gmail.com",
    "url": "https://github.com/chrischall"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/chrischall/opentable-mcp"
  },
  "homepage": "https://github.com/chrischall/opentable-mcp",
  "support": "https://github.com/chrischall/opentable-mcp/issues",
  "license": "MIT",
  "keywords": ["opentable", "reservations", "restaurants", "dining", "booking"],
  "server": {
    "type": "node",
    "entry_point": "dist/bundle.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/dist/bundle.js"]
    }
  },
  "user_config": {},
  "tools": [
    { "name": "opentable_list_reservations",  "description": "List upcoming / past / all reservations" },
    { "name": "opentable_get_profile",        "description": "Get the authenticated user's profile" },
    { "name": "opentable_list_favorites",     "description": "List saved restaurants" },
    { "name": "opentable_add_favorite",       "description": "Save a restaurant" },
    { "name": "opentable_remove_favorite",    "description": "Remove a saved restaurant" },
    { "name": "opentable_search_restaurants", "description": "Search restaurants by term, location, date, party size" },
    { "name": "opentable_get_restaurant",     "description": "Get full details for a restaurant" },
    { "name": "opentable_find_slots",         "description": "List available reservation slots at a restaurant" },
    { "name": "opentable_book",               "description": "Book a reservation using a fresh slot token" },
    { "name": "opentable_cancel",             "description": "Cancel a reservation" }
  ],
  "compatibility": {
    "platforms": ["darwin", "win32", "linux"],
    "runtimes": { "node": ">=18.0.0" }
  }
}
```

- [ ] **Step 2: Replace `README.md`**

```markdown
# opentable-mcp

OpenTable reservation management for Claude — search, book, cancel, list, and favorite restaurants via natural language.

> **v0.3.0-alpha.1:** backed by a companion Chrome extension that proxies requests through your real, signed-in OpenTable tab. 10 tools. No password storage, no cookie lifecycle to manage — the browser holds the session.

## How it works

OpenTable has no public API and its Akamai Bot Manager blocks non-browser clients on most paths. v0.3 sidesteps that by splitting the work:

- An **MCP server** runs in Node, exposing 10 tools to Claude. It doesn't talk to OpenTable directly.
- A **Chrome extension** runs in your browser, owns a pinned opentable.com tab, and forwards fetch requests that the MCP server sends over localhost WebSocket.
- Every request Chrome makes is indistinguishable from a real page interaction — same TLS, same cookies, same JS-solved Akamai state.

## Tools

| Tool | Purpose |
| --- | --- |
| `opentable_list_reservations` | Upcoming / past reservations with security tokens |
| `opentable_get_profile` | Name, email, phones, loyalty points, metro |
| `opentable_list_favorites` | Saved restaurants |
| `opentable_add_favorite` / `opentable_remove_favorite` | Manage saved list |
| `opentable_search_restaurants` | Search by term, location, date, party size |
| `opentable_get_restaurant` | Full restaurant details |
| `opentable_find_slots` | Available reservation slots |
| `opentable_book` | Book a slot (requires token from `find_slots`) |
| `opentable_cancel` | Cancel by confirmation_number + security_token |

## Install

### 1. MCP server

```bash
npm install
npm run build
node dist/bundle.js
```

Banner: `v0.3.0-alpha.1 — WebSocket bridge to Chrome extension on 127.0.0.1:37149`.

### 2. Companion Chrome extension

1. `chrome://extensions` → enable **Developer mode** (top-right).
2. **Load unpacked** → select the `extension/` directory in this repo.
3. The extension icon appears in the toolbar. Click it:
   - **WebSocket** row: green when the MCP server is running.
   - **OpenTable tab** row: green when a pinned opentable.com tab is open.
   - **Signed in** row: green when `authCke` cookie is present.
4. If not signed in: the extension opens a pinned tab at opentable.com for you. Sign in via email OTP. The auth dot turns green.

No additional setup. No env vars. No cookie-copy rituals.

## Claude Desktop / MCPB

Install via the bundled `.mcpb` file. Since v0.3 needs the extension too, the MCPB doesn't prompt for any credentials — just install it, then install the Chrome extension separately.

## Test

```bash
npm test              # unit tests (52+ passing)
npm run smoke         # read-only round-trip of all 10 tools
npm run smoke -- --write   # also books a reservation and cancels it
```

## Troubleshooting

- **Tool calls hang** — check the extension popup. If WS is red, is `node dist/bundle.js` running? If tab is red, click "Open OpenTable tab".
- **"Not signed in"** — the pinned tab logged out. Open it, sign in, try again.
- **Book fails with `SLOT_TAKEN`** — find_slots tokens expire in seconds; try again.
- **Extension not reconnecting after sleep** — open popup and click "Reconnect WebSocket". MV3 service workers go idle after ~30s; our `chrome.alarms` keepalive should handle most cases but isn't bulletproof.

## Limitations

- Chrome / Chromium family only (Brave, Edge, Arc, Vivaldi work). Safari: TBD if demand.
- Requires a pinned opentable.com tab to be open. The extension auto-opens one if missing.
- All write operations are real — `opentable_book` makes a real reservation, `opentable_cancel` cancels a real one. Test against venues you're willing to book/cancel at.

---

This project was developed and is maintained by AI (Claude Opus 4.7).
```

- [ ] **Step 3: Replace `CLAUDE.md`**

```markdown
# CLAUDE.md — opentable-mcp

Guidance for Claude working in this repo.

## Commands

- `npm test` — vitest unit tests.
- `npm run build` — tsc + esbuild bundle to `dist/bundle.js`.
- `npm run smoke` — full live e2e against all 10 tools (requires extension + signed-in tab).
- `npm run dev` — run the MCP server directly (after `npm run build`).

## Layout

- `src/ws-server.ts` — WebSocket server that the companion extension connects to. Single-connection, per-request timeout, ping/pong keepalive.
- `src/client.ts` — `OpenTableClient` wrapping the WS server. `fetchHtml(path)` for SSR pages, `fetchJson(path, init)` for write endpoints.
- `src/endpoint-templates.ts` — URLs / methods captured from live OpenTable via the extension's XHR logger. Update when OpenTable breaks them.
- `src/parse-*.ts` — parsers per page / per endpoint response. Each has its own tests in `tests/parse-*.test.ts`.
- `src/tools/*.ts` — one file per tool group; each exports a `registerXxxTools(server, client)` function.
- `src/index.ts` — MCP bootstrap; starts the WS server, registers all 10 tools, wires stdio.
- `extension/` — MV3 Chrome extension. `background.js` owns the WS, `content.js` runs in page context.

## Conventions

- Tools are `opentable_*`-prefixed.
- Tool return shape: `{ content: [{ type: 'text', text: JSON.stringify(..., null, 2) }] }`.
- Readonly tools set `annotations: { readOnlyHint: true }`.
- SSR parsers extract `__INITIAL_STATE__` via `extractInitialState` (brace-balanced walker).
- Write operations use captured endpoints in `src/endpoint-templates.ts`. Don't invent paths — run the discovery pass if something's missing.

## Known gotchas

- MV3 service workers sleep aggressively. We run a `chrome.alarms` tick every 25s and ping/pong every 20s. If the WS is persistently flaky, consider the Native Messaging fallback (documented in the v0.3 spec).
- OpenTable's Akamai returns 2.6 KB behavioral-challenge pages for public paths when fetched without a real browser. Don't try to revive cycletls — the extension transport is the architecture.
```

- [ ] **Step 4: Commit**

```bash
git add manifest.json README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: rewrite for v0.3 — companion-extension architecture

- manifest.json: 10 tools registered, user_config empty (no cookies prompt).
- README: install flow in two steps (MCP server, Chrome extension),
  troubleshooting, limitations.
- CLAUDE.md: updated layout + conventions + gotchas (MV3 sleep, Akamai).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Update CI, bump versions, final verification

**Files:**
- Modify: `package.json` (version)
- Modify: `src/index.ts` (version string inside the `McpServer` constructor)
- Verify: `.github/workflows/ci.yml` doesn't reference deleted scripts

- [ ] **Step 1: Check CI workflows**

Run: `grep -rE 'cycletls|setup-auth|e2e-phase1|OPENTABLE_COOKIES' .github/`
Expected: no matches (CI was transport-agnostic). If any appear, remove those lines.

- [ ] **Step 2: Bump version to `0.3.0-alpha.1` if not already**

Ensure `package.json` `"version": "0.3.0-alpha.1"`.
Ensure `src/index.ts`'s `new McpServer({ ..., version: '0.3.0-alpha.1' })`.
Ensure `manifest.json` `"version": "0.3.0-alpha.1"`.

- [ ] **Step 3: Full suite + build**

Run: `npm run build && npm test`
Expected: build clean, all tests pass (expect ~65+ tests after adding the new ones: 52 prior + parse-slots (4) + parse-book-response (3) + find_slots tool test + book tests (2) + cancel tests (2) + favorites new tests (2) ≈ 65).

- [ ] **Step 4: Run live smoke (read-only mode)**

Ensure MCP server running + extension loaded + signed in, then:
```bash
npm run smoke
```
Expected: 10 lines, each with a non-empty shape summary.

- [ ] **Step 5: Commit any pending version/docs touches**

```bash
git add -A
git diff --cached --stat
git commit -m "$(cat <<'EOF'
chore: final v0.3.0-alpha.1 alignment — versions synced, CI verified

Versions in package.json, manifest.json, and src/index.ts all say
0.3.0-alpha.1. CI workflows don't reference any removed artifacts.
Full local smoke green against a live account.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Push and let CI run**

```bash
git push
gh pr create --title "v0.3 companion Chrome extension" --body "$(cat <<'EOF'
## Summary

Replace the cycletls transport with a Chrome MV3 companion extension that
proxies fetches through the user's signed-in OpenTable tab. 10 tools,
including all the write operations that Akamai blocked in v0.2.

## Test plan

- [x] 65+ unit tests green
- [x] `npm run smoke` round-trips all 10 read-only tools
- [ ] `npm run smoke -- --write` books + cancels a reservation and
      toggles a favorite (manual, not for CI)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then watch CI:
```bash
gh pr checks --watch
```

---

## Self-review checklist (for the engineer executing this plan)

- [ ] Every `git commit` in the plan has been executed.
- [ ] `npm test` is green after every task, not just the final one.
- [ ] `npm run build` succeeds with no TS errors from Task 6 onwards.
- [ ] `dist/bundle.js` is produced and starts with `#!/usr/bin/env node`.
- [ ] `src/endpoint-templates.ts` has real values (not placeholder strings) in every field.
- [ ] `extension/background.js` and `extension/content.js` are loaded manually via `chrome://extensions → Load unpacked` and show a green dot when the server is running.
- [ ] Live e2e: `npm run smoke` exits 0 with sensible output for all 10 tools.
- [ ] Coverage target: ≥ 80% lines on `src/ws-server.ts`, `src/client.ts`, each `src/parse-*.ts`, each `src/tools/*.ts`. Run `npm run test:coverage` if you're unsure.
- [ ] README and CLAUDE.md match the shipped behavior.
- [ ] Versions aligned across `package.json`, `manifest.json`, `src/index.ts`.
