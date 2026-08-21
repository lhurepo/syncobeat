// SyncoBeat background service worker (MV3).
// Its only job is seeding first-run defaults. onInstalled also fires on
// extension updates, so newly added settings get defaults for existing users
// without clobbering anything they already changed.
//
// Keep this table in sync with sanitizeSettings() in content.js / popup.js.

const DEFAULTS = {
  bpm: 120,
  sig: 4,
  subdivision: 1,
  barOffset: 0,
  accentEnabled: true,
  volume: 0.8,
  syncOffsetMs: 0,
  enabled: true,
  clickSound: 'original',
  mode: 'auto',
  hotkey: 'KeyB',
  lockHotkey: 'KeyV',
  loopMarkHotkey: 'KeyG',
  loopJumpHotkey: 'KeyH',
  overlayEnabled: true,
  theme: 'system',
  presets: [60, 90, 120, 160]
};

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const existing = await chrome.storage.local.get(Object.keys(DEFAULTS));
    const toSet = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (existing[key] === undefined) {
        toSet[key] = DEFAULTS[key];
      }
    }
    if (Object.keys(toSet).length > 0) {
      await chrome.storage.local.set(toSet);
    }
  } catch (err) {
    console.error('[SyncoBeat] onInstalled error:', err);
  }
});
