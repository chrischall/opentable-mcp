// Popup UI. Polls the service worker via chrome.runtime.sendMessage
// every 2s for WS + tab state, and reads the opentable.com authCke
// cookie directly to show the sign-in dot. Two buttons: open/focus an
// opentable tab, force a WS reconnect.

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
