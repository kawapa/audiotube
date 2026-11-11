// AudioTube – isolated content script.
// Mirrors the extension setting (chrome.storage) into the page's localStorage,
// where inject.js can read it synchronously at document_start.
const KEY = 'audiotube_enabled';
const isTopFrame = window === window.top;

// Returns true when the stored page value changed.
function mirror(enabled) {
  try {
    const next = enabled ? '1' : '0';
    const current = localStorage.getItem(KEY) ?? '1'; // inject.js defaults to enabled
    localStorage.setItem(KEY, next);
    return current !== next;
  } catch {
    return false;
  }
}

// The hooks in inject.js are installed at page start, so a changed setting
// only takes effect after a reload.
function applyAndReload(enabled) {
  if (mirror(enabled)) location.reload();
}

// Same-origin frames share localStorage, so only the top frame writes it;
// otherwise a frame could store the new value first and the top frame would
// never see a change to reload for.
if (isTopFrame) {
  chrome.storage.local.get({ enabled: true }, ({ enabled }) => applyAndReload(enabled));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) applyAndReload(changes.enabled.newValue);
  });
}
