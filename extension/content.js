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

    // Pull the CSRF token that capture-logger.js (main world) syncs into
    // the html element's dataset. OpenTable's write endpoints require it.
    // Not all GETs do, but it's harmless to send.
    const headers = { ...(init.headers ?? {}) };
    const csrf = document.documentElement.dataset.otMcpCsrf;
    if (csrf && !headers['x-csrf-token'] && !headers['X-Csrf-Token']) {
      headers['x-csrf-token'] = csrf;
    }

    const resp = await fetch(url, {
      method: init.method,
      headers,
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

// Note: the XHR logger used to live here, but content scripts run in an
// isolated JS world by default — their window.fetch patch doesn't affect
// the page's fetch, and window globals they set aren't visible from the
// DevTools Console. The logger now lives in extension/capture-logger.js
// and is loaded via a separate content_scripts entry with world: MAIN.
