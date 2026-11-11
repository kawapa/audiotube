// Włącza/wyłącza regułę DNR blokującą segmenty wideo klasycznego DASH.
// Tymczasowo (diagnostyka): reguła zawsze wyłączona – blokowała fallback i psuła odtwarzanie.
async function sync(enabled) {
  await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ['block_video'] });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  await chrome.storage.local.set({ enabled });
  sync(enabled);
});

chrome.runtime.onStartup.addListener(async () => {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  sync(enabled);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) sync(changes.enabled.newValue);
});
