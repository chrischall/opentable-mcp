// XHR / fetch logger for endpoint discovery (v0.3 Phase C).
//
// Runs in the page's MAIN world (see manifest.json → content_scripts).
// That's intentional — we need to patch the same window.fetch the page
// itself calls, and we need window.__otMcpCaptures to be visible from
// DevTools Console (which also runs in the main world).
//
// Captures every POST/PUT/DELETE to opentable.com/dapi/*, /dtp/*, or
// /restref/* into window.__otMcpCaptures. To pull them in DevTools:
//    copy(JSON.stringify(window.__otMcpCaptures, null, 2))

(function installCaptureLogger() {
  const CAPTURES = (window.__otMcpCaptures = window.__otMcpCaptures || []);
  const MATCHERS = [/\/dapi\//, /\/dtp\//, /\/restref\//];

  function shouldCapture(url, method) {
    if (!url || typeof url !== 'string') return false;
    if (!url.includes('opentable.com') && !url.startsWith('/')) return false;
    if (method === 'GET') return false;
    return MATCHERS.some((re) => re.test(url));
  }

  // Patch window.fetch
  const origFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input && input.url;
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

  console.log('[opentable-mcp] capture logger installed (main world)');

  // Sync the page's CSRF token into a DOM data attribute so the
  // isolated-world content script (which can't see window globals) can
  // pick it up for outbound POSTs. Re-syncs every 2s in case the page
  // rotates the token on SPA navigation.
  function syncCsrf() {
    const token = /** @type {string | undefined} */ (window.__CSRF_TOKEN__);
    if (typeof token === 'string' && token.length > 0) {
      document.documentElement.dataset.otMcpCsrf = token;
    }
  }
  syncCsrf();
  setInterval(syncCsrf, 2000);
})();
