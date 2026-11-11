// AudioTube – ISOLATED world. Synchronizuje ustawienie chrome.storage -> localStorage (czytane przez inject.js).
const KEY = 'audiotube_enabled';

function apply(enabled) {
  try {
    const next = enabled ? '1' : '0';
    const changed = localStorage.getItem(KEY) !== next;
    localStorage.setItem(KEY, next);
    return changed;
  } catch { return false; }
}

chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
  // Zmiana wartości względem poprzedniej sesji wymaga przeładowania (hooki działają od document_start).
  if (apply(enabled)) location.reload();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled && apply(changes.enabled.newValue)) location.reload();
});
