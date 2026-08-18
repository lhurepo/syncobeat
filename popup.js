// SyncoBeat popup controller.
//
// The popup is the single writer of settings: every control writes to
// chrome.storage.local, and content scripts (in every YouTube tab) react via
// storage.onChanged. Live playback state flows the other way over a Port —
// the content script pushes a state snapshot on every change plus a light
// 'beat' tick at each audible click, so there is no polling.

const els = {
  bpmValue: document.getElementById('bpm-value'),
  bpmInput: document.getElementById('bpm-input'),
  bpmSlider: document.getElementById('bpm-slider'),
  bpmHalf: document.getElementById('bpm-half'),
  bpmDouble: document.getElementById('bpm-double'),
  tapTempo: document.getElementById('tap-tempo'),
  sigSelect: document.getElementById('sig-select'),
  subdivisionSelect: document.getElementById('subdivision-select'),
  clickSoundSelect: document.getElementById('click-sound-select'),
  volumeSlider: document.getElementById('volume-slider'),
  volumeValue: document.getElementById('volume-value'),
  offsetSlider: document.getElementById('offset-slider'),
  offsetValue: document.getElementById('offset-value'),
  enableToggle: document.getElementById('enable-toggle'),
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  beats: document.getElementById('beats'),
  barDec: document.getElementById('bar-dec'),
  barInc: document.getElementById('bar-inc'),
  barOffsetDisplay: document.getElementById('bar-offset-display'),
  accentToggle: document.getElementById('accent-toggle'),
  presetSave: document.getElementById('preset-save'),
  presetChips: document.getElementById('preset-chips'),
  modeSegments: document.getElementById('mode-segments'),
  modeCaption: document.getElementById('mode-caption'),
  transportRow: document.getElementById('transport-row'),
  transportToggle: document.getElementById('transport-toggle'),
  lockToggle: document.getElementById('lock-toggle'),
  hotkeyRow: document.getElementById('hotkey-row'),
  hotkeyBadge: document.getElementById('hotkey-badge'),
  hotkeySet: document.getElementById('hotkey-set'),
  lockHotkeyRow: document.getElementById('lock-hotkey-row'),
  lockHotkeyBadge: document.getElementById('lock-hotkey-badge'),
  lockHotkeySet: document.getElementById('lock-hotkey-set')
};

const MAX_PRESETS = 8;
const CLICK_SOUNDS = new Set(['original', 'woodblock', 'clave', 'softsine']);
const TIME_SIGS = new Set([2, 3, 4, 5, 6, 7]);
const SUBDIVISIONS = new Set([1, 2, 3, 4]);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const str = (v, d) => (typeof v === 'string' && v.length > 0 ? v : d);

// Defaults live in background.js (seeded on install); keep in sync.
function sanitizeSettings(raw) {
  const r = raw || {};
  return {
    bpm: clamp(Math.round(num(r.bpm, 120)), 20, 300),
    sig: TIME_SIGS.has(r.sig) ? r.sig : 4,
    subdivision: SUBDIVISIONS.has(r.subdivision) ? r.subdivision : 1,
    barOffset: Number.isFinite(r.barOffset) ? Math.trunc(r.barOffset) : 0,
    accentEnabled: typeof r.accentEnabled === 'boolean' ? r.accentEnabled : true,
    volume: clamp(num(r.volume, 0.8), 0, 1),
    syncOffsetMs: clamp(Math.round(num(r.syncOffsetMs, 0)), -500, 500),
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    clickSound: CLICK_SOUNDS.has(r.clickSound) ? r.clickSound : 'original',
    mode: r.mode === 'manual' ? 'manual' : 'auto',
    hotkey: str(r.hotkey, 'KeyB'),
    lockHotkey: str(r.lockHotkey, 'KeyV'),
    presets: sanitizePresets(r.presets)
  };
}

function sanitizePresets(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const n of arr) {
    const v = Math.round(Number(n));
    if (!isFinite(v) || v < 20 || v > 300) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  out.sort((a, b) => a - b);
  return out.slice(0, MAX_PRESETS);
}

let s = sanitizeSettings({});

// Live playback state pushed by the content script. Settings fields are never
// taken from pushes — the popup owns them — which avoids stale-echo races
// while dragging a slider.
const live = {
  connected: false,
  isPlaying: false,
  locked: false,
  videoPresent: false,
  videoPlaying: false,
  adShowing: false
};

let port = null;
let portRetry = null;
let tabIsYouTube = false;
let flashTimer = null;

// --- Storage writes (debounced for continuous controls) ----------------------
let pendingWrite = {};
let writeTimer = null;

function write(partial, immediate = false) {
  Object.assign(pendingWrite, partial);
  if (immediate) {
    flushWrite();
    return;
  }
  if (!writeTimer) writeTimer = setTimeout(flushWrite, 80);
}

function flushWrite() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const p = pendingWrite;
  pendingWrite = {};
  if (Object.keys(p).length === 0) return;
  try { chrome.storage.local.set(p); } catch (_) { /* noop */ }
}

// --- Port to the content script ----------------------------------------------
async function connect() {
  if (portRetry) {
    clearTimeout(portRetry);
    portRetry = null;
  }
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) { /* fall through */ }
  tabIsYouTube = !!(tab && typeof tab.url === 'string' && tab.url.includes('youtube.com'));
  if (!tab || tab.id == null) {
    renderStatus();
    return;
  }
  try {
    port = chrome.tabs.connect(tab.id, { name: 'syncobeat' });
  } catch (_) {
    port = null;
    renderStatus();
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // swallow "receiving end does not exist"
    port = null;
    live.connected = false;
    renderStatus();
    renderTransport();
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (portRetry) clearTimeout(portRetry);
  portRetry = setTimeout(connect, 1200);
}

function sendCommand(type) {
  if (!port) return;
  try { port.postMessage({ type }); } catch (_) { /* disconnecting */ }
}

function onPortMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'beat') {
    flashBeat(msg.beat);
    return;
  }
  if (msg.type === 'state') {
    live.connected = true;
    live.isPlaying = !!msg.isPlaying;
    live.locked = !!msg.locked;
    live.videoPresent = !!msg.videoPresent;
    live.videoPlaying = !!msg.videoPlaying;
    live.adShowing = !!msg.adShowing;
    renderStatus();
    renderTransport();
    renderModeCaption();
    if (!live.isPlaying) flashBeat(0);
  }
}

// --- Rendering -----------------------------------------------------------------
function renderBeatsContainer() {
  els.beats.innerHTML = '';
  const count = s.sig;
  // Accented beat (0-indexed within the bar) satisfies
  // ((i + barOffset) % sig) === 0  →  i ≡ -barOffset (mod sig)
  const accentIdx = (((-s.barOffset) % count) + count) % count;
  for (let i = 0; i < count; i += 1) {
    const d = document.createElement('div');
    const isAccent = s.accentEnabled && i === accentIdx;
    d.className = 'beat' + (isAccent ? ' accent' : '');
    els.beats.appendChild(d);
  }
}

function flashBeat(beat) {
  const dots = els.beats.querySelectorAll('.beat');
  dots.forEach((d, i) => d.classList.toggle('active', i === beat - 1));
  if (flashTimer) clearTimeout(flashTimer);
  if (beat > 0) {
    flashTimer = setTimeout(() => {
      dots.forEach((d) => d.classList.remove('active'));
    }, 110);
  }
}

function setStatus(kind, text) {
  els.status.classList.remove('synced', 'paused', 'none');
  els.status.classList.add(kind);
  els.statusText.textContent = text;
  els.statusText.title = text;
}

function renderStatus() {
  if (!live.connected) {
    if (tabIsYouTube) setStatus('paused', 'Reload this YouTube tab');
    else setStatus('none', 'Open a YouTube video');
    return;
  }
  if (!s.enabled) {
    setStatus('none', 'Metronome off');
    return;
  }
  if (live.adShowing) {
    setStatus('paused', 'Ad playing — click paused');
    return;
  }
  if (s.mode === 'manual') {
    const lockKey = hotkeyDisplayName(s.lockHotkey);
    const startKey = hotkeyDisplayName(s.hotkey);
    if (live.locked && live.isPlaying) setStatus('synced', `Locked to video (${lockKey} to unlock)`);
    else if (live.locked && !live.isPlaying) setStatus('paused', 'Locked — paused with video');
    else if (live.isPlaying) setStatus('synced', `Manual — running (${lockKey} to lock)`);
    else setStatus('paused', `Manual — press ${startKey} or Start`);
    return;
  }
  if (!live.videoPresent) setStatus('none', 'No video on this page');
  else if (live.videoPlaying && live.isPlaying) setStatus('synced', 'Synced');
  else if (!live.videoPlaying) setStatus('paused', 'Paused');
  else setStatus('paused', 'Waiting…');
}

function setSwitch(el, on) {
  if (!el) return;
  el.classList.toggle('on', on);
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

function renderAccent() {
  const sig = s.sig || 4;
  const accentIdx0 = (((-s.barOffset) % sig) + sig) % sig;
  els.barOffsetDisplay.textContent = s.accentEnabled ? `Beat ${accentIdx0 + 1}` : 'Off';
  setSwitch(els.accentToggle, s.accentEnabled);
}

function renderBpm() {
  els.bpmValue.textContent = String(s.bpm);
  els.bpmSlider.value = String(s.bpm);
}

function renderVolume() {
  const pct = Math.round(s.volume * 100);
  els.volumeSlider.value = String(pct);
  els.volumeValue.textContent = `${pct}%`;
}

function renderOffset() {
  els.offsetSlider.value = String(s.syncOffsetMs);
  els.offsetValue.textContent = `${s.syncOffsetMs > 0 ? '+' : ''}${s.syncOffsetMs} ms`;
}

function renderPresets() {
  els.presetChips.innerHTML = '';
  if (!s.presets.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No presets yet.';
    els.presetChips.appendChild(empty);
  } else {
    for (const bpm of s.presets) {
      const wrap = document.createElement('div');
      wrap.className = 'chip-wrap';

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (bpm === s.bpm ? ' current' : '');
      chip.textContent = String(bpm);
      chip.setAttribute('aria-label', `Apply ${bpm} bpm`);
      chip.addEventListener('click', () => setBpm(bpm, true));
      wrap.appendChild(chip);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chip-del';
      del.textContent = '×';
      del.setAttribute('aria-label', `Delete ${bpm} bpm preset`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        s.presets = s.presets.filter((n) => n !== bpm);
        write({ presets: s.presets }, true);
        renderPresets();
      });
      wrap.appendChild(del);

      els.presetChips.appendChild(wrap);
    }
  }

  const already = s.presets.includes(s.bpm);
  const full = s.presets.length >= MAX_PRESETS;
  els.presetSave.textContent = `+ Save ${s.bpm}`;
  els.presetSave.disabled = already || full;
  if (full && !already) els.presetSave.title = `Limit ${MAX_PRESETS} presets — delete one first.`;
  else if (already) els.presetSave.title = 'Already saved.';
  else els.presetSave.title = `Save ${s.bpm} bpm as a preset.`;
}

function renderMode() {
  els.modeSegments.querySelectorAll('button[data-mode]').forEach((b) => {
    const on = b.getAttribute('data-mode') === s.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const manual = s.mode === 'manual';
  els.transportRow.hidden = !manual;
  els.hotkeyRow.hidden = !manual;
  els.lockHotkeyRow.hidden = !manual;
  renderTransport();
  renderModeCaption();
}

function renderTransport() {
  if (s.mode !== 'manual') return;
  const ready = live.connected && s.enabled;
  els.transportToggle.textContent = live.isPlaying ? '■ Stop' : '▶ Start';
  els.transportToggle.disabled = !ready;
  els.lockToggle.textContent = live.locked ? 'Unlock' : 'Lock to video';
  els.lockToggle.disabled = !ready || !live.isPlaying || (!live.locked && !live.videoPresent);
}

function renderModeCaption() {
  if (s.mode !== 'manual') {
    els.modeCaption.innerHTML = '<strong>Auto</strong> — click follows the video.';
  } else if (live.locked) {
    els.modeCaption.innerHTML =
      `<strong>Manual — locked</strong> — click follows the video. Press <code>${escapeHtml(hotkeyDisplayName(s.lockHotkey))}</code> on the page to unlock.`;
  } else {
    els.modeCaption.innerHTML =
      `<strong>Manual</strong> — press <code>${escapeHtml(hotkeyDisplayName(s.hotkey))}</code> on the page (or Start) on beat 1. <code>${escapeHtml(hotkeyDisplayName(s.lockHotkey))}</code> locks to the video.`;
  }
}

function renderHotkey() {
  renderHotkeyBadge('hotkey', els.hotkeyBadge, els.hotkeySet, s.hotkey);
  renderHotkeyBadge('lockHotkey', els.lockHotkeyBadge, els.lockHotkeySet, s.lockHotkey);
}

function renderHotkeyBadge(target, badge, setBtn, code) {
  if (captureTarget === target) {
    badge.textContent = 'Press a key…';
    badge.classList.add('capturing');
    setBtn.textContent = 'Cancel';
  } else {
    badge.textContent = hotkeyDisplayName(code);
    badge.classList.remove('capturing');
    setBtn.textContent = 'Set';
  }
}

function renderAll() {
  renderBpm();
  els.sigSelect.value = String(s.sig);
  els.subdivisionSelect.value = String(s.subdivision);
  els.clickSoundSelect.value = s.clickSound;
  renderVolume();
  renderOffset();
  setSwitch(els.enableToggle, s.enabled);
  renderAccent();
  renderBeatsContainer();
  renderPresets();
  renderMode();
  renderHotkey();
  renderStatus();
}

// KeyboardEvent.code → human-readable label.
function hotkeyDisplayName(code) {
  if (!code) return '—';
  const named = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Esc',
    Backspace: '⌫', Delete: 'Del',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Minus: '−', Equal: '=', Slash: '/', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    BracketLeft: '[', BracketRight: ']', Backquote: '`'
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- BPM helpers ------------------------------------------------------------------
function setBpm(bpm, immediate = false) {
  const v = clamp(Math.round(Number(bpm)) || 120, 20, 300);
  s.bpm = v;
  renderBpm();
  renderPresets();
  write({ bpm: v }, immediate);
}

// --- Tap tempo ----------------------------------------------------------------------
// Median of the recent tap intervals — robust against one sloppy tap.
const taps = [];

function onTap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length > 8) taps.shift();

  els.tapTempo.classList.add('flash');
  setTimeout(() => els.tapTempo.classList.remove('flash'), 90);

  if (taps.length < 2) return;
  const intervals = taps.slice(1).map((t, i) => t - taps[i]).sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  const median = intervals.length % 2
    ? intervals[mid]
    : (intervals[mid - 1] + intervals[mid]) / 2;
  setBpm(60000 / median, true);
}

// --- Editable BPM display --------------------------------------------------------------
function startBpmEdit() {
  els.bpmValue.hidden = true;
  els.bpmInput.hidden = false;
  els.bpmInput.value = String(s.bpm);
  els.bpmInput.focus();
  els.bpmInput.select();
}

function endBpmEdit(commit) {
  if (els.bpmInput.hidden) return;
  els.bpmInput.hidden = true;
  els.bpmValue.hidden = false;
  if (commit) {
    const v = parseInt(els.bpmInput.value, 10);
    if (isFinite(v)) setBpm(v, true);
  }
}

// --- Hotkey capture ---------------------------------------------------------------------
// One capture session at a time; `captureTarget` is 'hotkey' or 'lockHotkey'.
// Next non-modifier keydown commits, Escape cancels, a key already bound to
// the other slot is rejected with a red flash (capture stays active).
let captureTarget = null;
let captureCleanup = null;

const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'
]);

function startHotkeyCapture(target) {
  if (captureTarget && captureTarget !== target) endHotkeyCapture(false);
  if (captureTarget === target) return;
  captureTarget = target;
  renderHotkey();

  const badge = target === 'hotkey' ? els.hotkeyBadge : els.lockHotkeyBadge;
  const otherCode = target === 'hotkey' ? s.lockHotkey : s.hotkey;

  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    if (e.code === 'Escape') {
      endHotkeyCapture(false);
      return;
    }
    if (MODIFIER_CODES.has(e.code)) return;
    if (typeof e.code !== 'string' || e.code.length === 0) return;
    if (e.code === otherCode) {
      badge.textContent = 'In use';
      badge.classList.add('error');
      setTimeout(() => {
        badge.classList.remove('error');
        if (captureTarget === target) badge.textContent = 'Press a key…';
      }, 600);
      return;
    }
    endHotkeyCapture(true, e.code);
  };

  captureCleanup = () => {
    window.removeEventListener('keydown', handler, true);
    captureCleanup = null;
  };
  window.addEventListener('keydown', handler, true);
}

function endHotkeyCapture(save, code) {
  const target = captureTarget;
  if (captureCleanup) captureCleanup();
  captureTarget = null;
  if (save && typeof code === 'string' && code.length > 0 && target) {
    const badge = target === 'hotkey' ? els.hotkeyBadge : els.lockHotkeyBadge;
    s[target] = code;
    write({ [target]: code }, true);
    badge.classList.add('confirmed');
    setTimeout(() => badge.classList.remove('confirmed'), 700);
  }
  renderHotkey();
  renderModeCaption();
  renderStatus();
}

// --- Control wiring --------------------------------------------------------------------------
function wireControls() {
  els.bpmSlider.addEventListener('input', () => {
    setBpm(parseInt(els.bpmSlider.value, 10));
  });
  els.bpmHalf.addEventListener('click', () => setBpm(s.bpm / 2, true));
  els.bpmDouble.addEventListener('click', () => setBpm(s.bpm * 2, true));
  // pointerdown, not click — tap timing should be measured at the press.
  els.tapTempo.addEventListener('pointerdown', onTap);

  els.bpmValue.addEventListener('click', startBpmEdit);
  els.bpmValue.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      startBpmEdit();
    }
  });
  els.bpmInput.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') endBpmEdit(true);
    else if (e.code === 'Escape') endBpmEdit(false);
  });
  els.bpmInput.addEventListener('blur', () => endBpmEdit(true));

  els.sigSelect.addEventListener('change', () => {
    s.sig = parseInt(els.sigSelect.value, 10) || 4;
    renderBeatsContainer();
    renderAccent();
    write({ sig: s.sig }, true);
  });

  els.subdivisionSelect.addEventListener('change', () => {
    s.subdivision = parseInt(els.subdivisionSelect.value, 10) || 1;
    write({ subdivision: s.subdivision }, true);
  });

  els.clickSoundSelect.addEventListener('change', () => {
    s.clickSound = CLICK_SOUNDS.has(els.clickSoundSelect.value)
      ? els.clickSoundSelect.value : 'original';
    write({ clickSound: s.clickSound }, true);
  });

  els.volumeSlider.addEventListener('input', () => {
    const pct = clamp(parseInt(els.volumeSlider.value, 10) || 0, 0, 100);
    s.volume = pct / 100;
    els.volumeValue.textContent = `${pct}%`;
    write({ volume: s.volume });
  });
  els.volumeSlider.addEventListener('dblclick', () => setSliderValue(els.volumeSlider, 80));

  els.offsetSlider.addEventListener('input', () => {
    s.syncOffsetMs = clamp(parseInt(els.offsetSlider.value, 10) || 0, -500, 500);
    els.offsetValue.textContent = `${s.syncOffsetMs > 0 ? '+' : ''}${s.syncOffsetMs} ms`;
    write({ syncOffsetMs: s.syncOffsetMs });
  });
  els.offsetSlider.addEventListener('dblclick', () => setSliderValue(els.offsetSlider, 0));

  els.enableToggle.addEventListener('click', () => {
    s.enabled = !s.enabled;
    setSwitch(els.enableToggle, s.enabled);
    write({ enabled: s.enabled }, true);
    renderStatus();
    renderTransport();
  });

  document.querySelectorAll('.nudge-btn[data-nudge]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-nudge');
      if (action === 'bpm-dec') nudgeSlider(els.bpmSlider, -1);
      else if (action === 'bpm-inc') nudgeSlider(els.bpmSlider, 1);
      else if (action === 'vol-dec') nudgeSlider(els.volumeSlider, -5);
      else if (action === 'vol-inc') nudgeSlider(els.volumeSlider, 5);
      else if (action === 'off-dec') nudgeSlider(els.offsetSlider, -5);
      else if (action === 'off-inc') nudgeSlider(els.offsetSlider, 5);
    });
  });

  els.barDec.addEventListener('click', () => {
    s.barOffset -= 1;
    renderAccent();
    renderBeatsContainer();
    write({ barOffset: s.barOffset }, true);
  });
  els.barInc.addEventListener('click', () => {
    s.barOffset += 1;
    renderAccent();
    renderBeatsContainer();
    write({ barOffset: s.barOffset }, true);
  });
  els.accentToggle.addEventListener('click', () => {
    s.accentEnabled = !s.accentEnabled;
    renderAccent();
    renderBeatsContainer();
    write({ accentEnabled: s.accentEnabled }, true);
  });

  els.presetSave.addEventListener('click', () => {
    if (s.presets.includes(s.bpm) || s.presets.length >= MAX_PRESETS) return;
    s.presets = sanitizePresets([...s.presets, s.bpm]);
    write({ presets: s.presets }, true);
    renderPresets();
  });

  els.modeSegments.querySelectorAll('button[data-mode]').forEach((b) => {
    b.addEventListener('click', () => {
      const mode = b.getAttribute('data-mode');
      if (mode !== 'auto' && mode !== 'manual') return;
      if (s.mode === mode) return;
      s.mode = mode;
      write({ mode }, true);
      renderMode();
      renderStatus();
    });
  });

  els.transportToggle.addEventListener('click', () => sendCommand('MANUAL_TOGGLE'));
  els.lockToggle.addEventListener('click', () => sendCommand('TOGGLE_LOCK'));

  wireHotkeyCapture('hotkey', els.hotkeySet, els.hotkeyBadge);
  wireHotkeyCapture('lockHotkey', els.lockHotkeySet, els.lockHotkeyBadge);
}

function wireHotkeyCapture(target, setBtn, badge) {
  setBtn.addEventListener('click', () => {
    if (captureTarget === target) endHotkeyCapture(false);
    else startHotkeyCapture(target);
  });
  badge.addEventListener('click', () => {
    if (captureTarget !== target) startHotkeyCapture(target);
  });
}

function nudgeSlider(slider, delta) {
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const cur = parseFloat(slider.value) || 0;
  setSliderValue(slider, clamp(cur + delta, min, max));
}

function setSliderValue(slider, value) {
  slider.value = String(value);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}

// --- Init --------------------------------------------------------------------------------------
async function init() {
  let stored = {};
  try { stored = await chrome.storage.local.get(null); } catch (_) { /* noop */ }
  s = sanitizeSettings(stored);
  renderAll();
  wireControls();
  connect();
}

// Keep the popup fresh when settings change underneath it — a per-video
// memory restore after navigation, or a tweak from another window. Echoes of
// this popup's own writes are no-ops (values already match) and anything
// arriving while a write is still debounced is skipped rather than clobbering
// the drag in progress.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (writeTimer || captureTarget) return;
  const raw = { ...s };
  for (const k of Object.keys(changes)) raw[k] = changes[k].newValue;
  const next = sanitizeSettings(raw);
  const dirty = Object.keys(next).some(
    (k) => JSON.stringify(next[k]) !== JSON.stringify(s[k])
  );
  if (!dirty) return;
  s = next;
  renderAll();
});

// Flush any debounced write before the popup dies mid-drag.
window.addEventListener('pagehide', flushWrite);
window.addEventListener('unload', flushWrite);

init();
