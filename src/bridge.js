// AudioTube – isolated content script.
// Mirrors the extension setting (chrome.storage) into the page's localStorage,
// where inject.js can read it synchronously at document_start, and reloads
// the frame when the mode it is running in no longer matches the setting.
const KEY = 'audiotube_enabled';

// Returns true when the value was stored.
function mirror(enabled) {
  try {
    localStorage.setItem(KEY, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

// inject.js reads the setting once at page start and records the mode it
// actually started in on <html>. Comparing against that (rather than against
// localStorage, which is shared by every same-origin tab and frame) makes each
// tab and frame reload itself when needed.
function applyAndReload(enabled) {
  // If storage is unavailable a reload would not change anything (and would loop).
  if (!mirror(enabled)) return;
  const active = document.documentElement?.dataset.audiotubeActive;
  if (active === undefined) return; // inject.js not active in this frame
  if ((active === '1') !== enabled) location.reload();
}

chrome.storage.local.get({ enabled: true }, ({ enabled }) => applyAndReload(enabled));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) applyAndReload(changes.enabled.newValue);
});
