// Populated in Task 5.
document.getElementById('open-btn').onclick = () => {
  chrome.tabs.create({ url: 'https://www.opentable.com/', pinned: true });
};
document.getElementById('reconnect-btn').onclick = () => {
  chrome.runtime.sendMessage({ type: 'reconnect' });
};
