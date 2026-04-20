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
