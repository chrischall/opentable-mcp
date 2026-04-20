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
