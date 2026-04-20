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
