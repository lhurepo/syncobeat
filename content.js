// SyncoBeat content script — Web Audio metronome for YouTube.
//
// Architecture:
//   settings — user preferences mirrored from chrome.storage.local. The popup
//              is the ONLY writer; this script reads once at startup and then
//              reacts to storage.onChanged (which also keeps every open
//              YouTube tab consistent, not just the active one).
//   runtime  — transport/scheduling state owned by this script and never
//              persisted: isPlaying, lock, beat grid, scheduled clicks.
//   port     — the popup drives runtime over a long-lived Port
//              ('MANUAL_TOGGLE', 'TOGGLE_LOCK'); state snapshots and per-beat
//              ticks are pushed back for the popup UI.
//
// Modes:
//   auto          — click phase-locks to the video timeline (beat 0 at t=0);
//                   follows play/pause/seek/rate/buffering and pauses in ads.
//   manual        — free-running; a page hotkey starts the click on the tap.
//   manual+locked — a second hotkey anchors the running click to the video
//                   clock, preserving its exact phase and beat numbering.

(() => {
  if (window.__syncoBeatLoaded) return;
  window.__syncoBeatLoaded = true;

  const PORT_NAME = 'syncobeat';

  // Scheduling profiles. Foreground uses a tight look-ahead so tempo/seek
  // changes react fast. Hidden tabs get their timers throttled to >=1s by
  // Chrome, so we buffer several seconds of clicks ahead instead — Web Audio
  // fires them sample-accurately regardless of JS timer jitter.
  const FOREGROUND = { lookahead: 0.12, intervalMs: 25 };
  const HIDDEN = { lookahead: 3.2, intervalMs: 500 };
  const CATCHUP_GAP = 1.0;        // scheduler stalled longer than this → re-anchor, don't burst-fire missed beats
  const DRIFT_TOLERANCE = 0.025;  // seconds of phase error vs the video clock before snapping back
  const DRIFT_STRIKES = 2;        // consecutive bad checks required (filters currentTime jitter spikes)
  const DRIFT_CHECK_INTERVAL = 0.5;
  const SUB_LEVEL = 0.35;         // subdivision click level relative to the main beat
  // Headroom above the slider's 0–1 range: 100% drives the click ~6 dB hot so
  // it cuts through the video. The limiter below catches the peaks.
  const OUTPUT_GAIN = 2.0;

  const CLICK_SOUNDS = new Set(['original', 'woodblock', 'clave', 'softsine']);
  const TIME_SIGS = new Set([2, 3, 4, 5, 6, 7]);
  const SUBDIVISIONS = new Set([1, 2, 3, 4]);

  // Per-video memory: the musical settings worth restoring when the user
  // returns to a tutorial. Global preferences (mode, volume, click sound,
  // hotkeys) are deliberately excluded. This script is the sole writer of the
  // MEMORY_KEY entry; the popup never touches it.
  const MEMORY_KEY = 'videoMemory';
  const MEMORY_FIELDS = ['bpm', 'sig', 'subdivision', 'barOffset', 'accentEnabled', 'syncOffsetMs'];
  const MEMORY_LIMIT = 50;
  const MEMORY_SAVE_DEBOUNCE_MS = 1000;

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const mod = (n, m) => ((n % m) + m) % m;
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
      lockHotkey: str(r.lockHotkey, 'KeyV')
    };
  }

  let settings = sanitizeSettings({});

  const rt = {
    // Lock state and phase offset are intentionally never persisted — a lock
    // is per-session and meaningless after a reload (the video clock and the
    // user's tapped beat 1 are no longer aligned).
    locked: false,
    phaseOffset: 0,   // video-time seconds at which beat 0 lands (locked mode)
    isPlaying: false,
    currentBeat: 0,   // beat-in-bar shown by the popup, set at audible time
    beatCounter: 0,   // 1-based number of the NEXT beat to schedule
    nextNoteTime: 0,  // audio-clock time of the next unscheduled beat
    playbackRate: 1,
    video: null,
    listenersAttached: false,
    playerEl: null,
    adShowing: false,
    adObserver: null,
    ctx: null,
    master: null,
    noiseBuf: null,
    schedulerTimer: null,
    scheduled: [],    // [{when, nodes, timer}] — cancellable pending clicks
    driftStrikes: 0,
    lastDriftCheck: 0,
    lastResyncAt: 0
  };

  let port = null;
  let currentVideoId = null;
  let memorySaveTimer = null;

  // The metronome is "video-driven" — reacts to play/pause/seek/rate and uses
  // phase-locked scheduling — in auto mode, or in manual mode while locked.
  function isVideoDriven() {
    return settings.mode === 'auto' || (settings.mode === 'manual' && rt.locked);
  }

  function videoPlayingNow() {
    return !!rt.video && !rt.video.paused && !rt.video.ended;
  }

  // --- Audio engine ----------------------------------------------------------
  function ensureAudio() {
    if (!rt.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      rt.ctx = new Ctx({ latencyHint: 'interactive' });
      rt.master = rt.ctx.createGain();
      // Safety limiter: OUTPUT_GAIN pushes clicks past unity, and accents +
      // subdivisions can overlap. A fast compressor tames the peaks without
      // dulling the transient.
      const limiter = rt.ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.1;
      rt.master.connect(limiter);
      limiter.connect(rt.ctx.destination);
      applyVolume();
      // If the OS suspends/resumes the context, our audio clock jumped —
      // realign to the video rather than clicking from a stale grid.
      rt.ctx.onstatechange = () => {
        if (rt.ctx && rt.ctx.state === 'running' && rt.isPlaying && isVideoDriven()) {
          rebaseToVideo();
        }
      };
    }
    if (rt.ctx.state === 'suspended') {
      rt.ctx.resume().catch(() => {});
    }
  }

  function applyVolume() {
    if (rt.master) rt.master.gain.value = settings.volume * OUTPUT_GAIN;
  }

  // Dispatch to the selected click voice. All voices are synthesized and
  // return their top-level gain node(s) so a pending click can be cancelled
  // by disconnecting (sources can't be stop()ped twice, so we detach instead).
  function scheduleClick(when, accent, level) {
    if (!rt.ctx) return [];
    switch (settings.clickSound) {
      case 'woodblock': return clickWoodblock(when, accent, level);
      case 'clave':     return clickTone(when, accent ? 2500 : 2000, 0.045, 0.9, level);
      case 'softsine':  return clickTone(when, accent ? 1200 : 880, 0.07, 0.8, level);
      case 'original':
      default:          return clickTone(when, accent ? 1200 : 800, 0.06, 1.0, level);
    }
  }

  // A single decaying sine: 1 ms attack, exponential decay to silence.
  // Covers the original beep, clave, and soft sine.
  function clickTone(when, freq, decay, peak, level) {
    const ctx = rt.ctx;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peak * level, when + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    osc.connect(env); env.connect(rt.master);
    osc.start(when); osc.stop(when + decay + 0.02);
    return [env];
  }

  // Lazily build (and cache) a short white-noise buffer for the woodblock attack.
  function getNoiseBuf() {
    if (rt.noiseBuf) return rt.noiseBuf;
    const ctx = rt.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * 0.02));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
    rt.noiseBuf = buf;
    return buf;
  }

  // Woodblock: two sine partials (f and 2.1f) with a fast woody decay, plus a
  // 1.5 ms noise transient for the sharp attack "tock".
  function clickWoodblock(when, accent, level) {
    const ctx = rt.ctx;
    const f = accent ? 1800 : 1300;
    const env = ctx.createGain();
    env.connect(rt.master);
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(0.9 * level, when + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);

    const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = f;
    const g1 = ctx.createGain(); g1.gain.value = 0.7; o1.connect(g1); g1.connect(env);
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.1;
    const g2 = ctx.createGain(); g2.gain.value = 0.3; o2.connect(g2); g2.connect(env);
    o1.start(when); o2.start(when);
    o1.stop(when + 0.07); o2.stop(when + 0.07);

    const noise = ctx.createBufferSource();
    noise.buffer = getNoiseBuf();
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.5 * level, when);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.0015);
    noise.connect(ng); ng.connect(rt.master);
    noise.start(when); noise.stop(when + 0.02);
    return [env, ng];
  }

  // --- Scheduled-click registry ------------------------------------------------
  // Every pending click is tracked so pauses/seeks/tempo changes can silence
  // clicks already committed inside the look-ahead window (essential when the
  // hidden-tab profile has buffered seconds of audio ahead).
  function registerBeat(when, nodes, beatInBar) {
    const entry = { when, nodes, timer: null };
    if (beatInBar > 0 && rt.ctx) {
      // Clicks are scheduled up to a full look-ahead early; delay the visual
      // beat update so the popup dot flashes when the click is audible.
      const delayMs = Math.max(0, (when - rt.ctx.currentTime) * 1000);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        rt.currentBeat = beatInBar;
        pushToPort({ type: 'beat', beat: beatInBar });
      }, delayMs);
    }
    rt.scheduled.push(entry);
  }

  function cancelScheduledFrom(t) {
    const keep = [];
    for (const entry of rt.scheduled) {
      if (entry.when >= t - 0.001) {
        for (const n of entry.nodes) {
          try { n.disconnect(); } catch (_) { /* already gone */ }
        }
        if (entry.timer) clearTimeout(entry.timer);
      } else {
        keep.push(entry);
      }
    }
    rt.scheduled = keep;
  }

  function pruneScheduled(now) {
    if (rt.scheduled.length === 0) return;
    rt.scheduled = rt.scheduled.filter((e) => e.when >= now - 0.5);
  }

  // --- Phase-lock math ---------------------------------------------------------
  // The beat grid in video time: beats land at anchor + k * beatInterval,
  // where anchor is 0 in auto mode, the user's tapped offset when locked, plus
  // the user's sync-offset trim in both cases.
  function videoGrid() {
    const rate = rt.playbackRate || 1;
    const beat = 60 / settings.bpm;
    const anchor = (settings.mode === 'manual' && rt.locked ? rt.phaseOffset : 0)
      + settings.syncOffsetMs / 1000;
    const t = rt.video.currentTime - anchor;
    const phase = mod(t, beat);
    return {
      untilNextWall: (beat - phase) / rate,
      nextCounter: Math.floor(t / beat) + 1
    };
  }

  function resyncToVideo() {
    if (!rt.video || !rt.ctx) return;
    const g = videoGrid();
    rt.nextNoteTime = rt.ctx.currentTime + g.untilNextWall;
    rt.beatCounter = g.nextCounter;
    rt.lastResyncAt = rt.ctx.currentTime;
    rt.driftStrikes = 0;
  }

  // Cancel pending clicks and realign to the video — the smooth correction
  // used for seeks, rate changes, offset changes, and drift snaps. Unlike a
  // stop/start it never touches lock state or auto-start conditions.
  function rebaseToVideo() {
    if (!rt.isPlaying || !rt.ctx || !rt.video) return;
    cancelScheduledFrom(rt.ctx.currentTime);
    resyncToVideo();
  }

  function secondsPerBeat() {
    // Playback rate only applies when the click is coupled to the video.
    const rate = isVideoDriven() ? (rt.playbackRate || 1) : 1;
    return (60 / settings.bpm) / rate;
  }

  // --- Scheduler loop ----------------------------------------------------------
  function schedulerPass() {
    if (!rt.isPlaying || !rt.ctx) return;
    const now = rt.ctx.currentTime;
    const profile = document.hidden ? HIDDEN : FOREGROUND;
    pruneScheduled(now);

    if (now - rt.nextNoteTime > CATCHUP_GAP) {
      // Timer stalled far past the buffered clicks (system sleep, heavy
      // throttling). Re-anchor instead of burst-firing every missed beat.
      if (isVideoDriven()) {
        resyncToVideo();
      } else {
        const spb = secondsPerBeat();
        const missed = Math.ceil((now - rt.nextNoteTime) / spb);
        rt.beatCounter += missed;
        rt.nextNoteTime += missed * spb;
      }
    }

    const spb = secondsPerBeat();
    while (rt.nextNoteTime < now + profile.lookahead) {
      const fireAt = Math.max(rt.nextNoteTime, now + 0.001);
      const beatIdx0 = rt.beatCounter - 1;
      const beatInBar = mod(beatIdx0, settings.sig) + 1;
      const accent = settings.accentEnabled
        && mod(beatIdx0 + settings.barOffset, settings.sig) === 0;

      registerBeat(fireAt, scheduleClick(fireAt, accent, 1), beatInBar);
      for (let k = 1; k < settings.subdivision; k += 1) {
        const at = fireAt + (spb * k) / settings.subdivision;
        registerBeat(at, scheduleClick(at, false, SUB_LEVEL), 0);
      }

      rt.nextNoteTime += spb;
      rt.beatCounter += 1;
    }

    maybeCorrectDrift(now);
    rt.schedulerTimer = setTimeout(schedulerPass, profile.intervalMs);
  }

  // The scheduler free-runs on the audio clock between resyncs, but the video
  // clock is a different clock domain and the two drift apart over long
  // sessions (worse on Bluetooth audio). Periodically measure the phase error
  // against the video and snap back when it exceeds tolerance twice in a row.
  function maybeCorrectDrift(now) {
    if (!isVideoDriven()) return;
    const v = rt.video;
    if (!v || v.paused || v.seeking || v.readyState < 2) {
      rt.driftStrikes = 0;
      return;
    }
    if (now - rt.lastDriftCheck < DRIFT_CHECK_INTERVAL) return;
    rt.lastDriftCheck = now;
    if (!document.contains(v)) { findVideo(); return; }
    if (now - rt.lastResyncAt < 0.3) return; // let a fresh resync settle

    const g = videoGrid();
    const spb = secondsPerBeat();
    // Phase-only error, folded into ±half a beat: being N whole beats ahead
    // (buffered look-ahead) must not read as drift.
    let err = (rt.nextNoteTime - (now + g.untilNextWall)) % spb;
    if (err > spb / 2) err -= spb;
    if (err < -spb / 2) err += spb;

    if (Math.abs(err) > DRIFT_TOLERANCE) {
      rt.driftStrikes += 1;
      if (rt.driftStrikes >= DRIFT_STRIKES) rebaseToVideo();
    } else {
      rt.driftStrikes = 0;
    }
  }

  // --- Transport -----------------------------------------------------------------
  function startMetronome() {
    if (!settings.enabled) return;
    if (isVideoDriven()) {
      if (!videoPlayingNow() || rt.adShowing) return;
      ensureAudio();
      resyncToVideo();
    } else {
      // Free-running manual: the toggle keypress IS beat 1.
      ensureAudio();
      rt.beatCounter = 1;
      rt.nextNoteTime = rt.ctx.currentTime;
    }
    rt.isPlaying = true;
    if (rt.schedulerTimer) clearTimeout(rt.schedulerTimer);
    schedulerPass();
    pushState();
  }

  // Halt the scheduler without disturbing lock state — used for video pauses,
  // buffering, and ads, so resuming play continues phase-correctly.
  function pauseScheduler() {
    if (rt.schedulerTimer) {
      clearTimeout(rt.schedulerTimer);
      rt.schedulerTimer = null;
    }
    if (rt.ctx) cancelScheduledFrom(rt.ctx.currentTime);
    rt.isPlaying = false;
    rt.currentBeat = 0;
    pushState();
  }

  // Full stop: scheduler off AND any lock cleared. Triggered by the user's
  // start/stop toggle or an explicit teardown (mode change, video removed).
  function stopMetronome() {
    pauseScheduler();
    if (rt.locked) {
      rt.locked = false;
      rt.phaseOffset = 0;
      syncVideoListeners();
      pushState();
    }
  }

  // Anchor the *currently running* click to the video clock, seamlessly. The
  // click is already at the right tempo, phase, and beat number (the user
  // tapped beat 1) — locking must NOT shift any of that. We only record where
  // the live beat grid sits in video time, so a later seek/pause/play can
  // reproduce the exact same beat times AND numbers (preserving the accent),
  // then start listening for video events. We deliberately do NOT resync here
  // — that would reset nextNoteTime and double-trigger a click already
  // committed within the look-ahead window.
  function lockToVideo() {
    if (settings.mode !== 'manual' || !rt.isPlaying || !rt.video || !rt.ctx) return;
    rt.playbackRate = rt.video.playbackRate || 1;
    const beat = 60 / settings.bpm;
    const untilNext = Math.max(0, rt.nextNoteTime - rt.ctx.currentTime);
    const nextBeatVideoTime = rt.video.currentTime + untilNext * rt.playbackRate;
    // Solve for the video time of "beat 0" so videoGrid() reproduces the live
    // schedule's beat times and numbering exactly. Reduce modulo one bar to
    // keep the stored value small — a whole-bar shift changes neither the
    // phase nor the accent.
    const origin = nextBeatVideoTime - rt.beatCounter * beat - settings.syncOffsetMs / 1000;
    const bar = beat * settings.sig;
    rt.phaseOffset = mod(origin, bar);
    rt.locked = true;
    syncVideoListeners();
    pushState();
  }

  function unlockFromVideo() {
    if (!rt.locked) return;
    rt.locked = false;
    rt.phaseOffset = 0;
    // Back to free-running: drop video listeners and just keep clicking.
    syncVideoListeners();
    pushState();
  }

  // A BPM change invalidates a lock (it's measured in beat lengths — those
  // just changed); the user re-taps. Free-running playback keeps the grid
  // anchored on the previous beat so the tempo knob feels continuous instead
  // of restarting at beat 1.
  function onTempoChanged(prevBpm) {
    if (rt.locked) {
      rt.locked = false;
      rt.phaseOffset = 0;
      syncVideoListeners();
    }
    if (!rt.isPlaying || !rt.ctx) return;
    if (isVideoDriven()) {
      rebaseToVideo();
      return;
    }
    const lastBeatTime = rt.nextNoteTime - 60 / prevBpm;
    rt.nextNoteTime = Math.max(rt.ctx.currentTime + 0.001, lastBeatTime + secondsPerBeat());
  }

  function applyMode() {
    // Switching semantics always stops the click; the user re-triggers.
    stopMetronome();
    syncVideoListeners();
    if (settings.mode === 'auto' && settings.enabled && videoPlayingNow() && !rt.adShowing) {
      startMetronome();
    }
    pushState();
  }

  // --- Video binding -------------------------------------------------------------
  const VIDEO_EVENTS = [
    ['play', onPlaying],
    ['playing', onPlaying],
    ['pause', onPauseLike],
    ['ended', onPauseLike],
    ['waiting', onPauseLike],
    ['emptied', onPauseLike],
    ['seeking', onSeeking],
    ['seeked', onSeeked],
    ['ratechange', onRateChange]
  ];

  function onPlaying() {
    if (!isVideoDriven() || rt.adShowing) return;
    if (rt.isPlaying) rebaseToVideo();
    else startMetronome();
  }
  function onPauseLike() {
    if (isVideoDriven() && rt.isPlaying) pauseScheduler();
  }
  function onSeeking() {
    // Silence clicks committed inside the look-ahead while the user scrubs.
    if (isVideoDriven() && rt.isPlaying && rt.ctx) cancelScheduledFrom(rt.ctx.currentTime);
  }
  function onSeeked() {
    if (!isVideoDriven() || !rt.video) return;
    if (rt.video.paused || rt.video.ended) {
      if (rt.isPlaying) pauseScheduler();
      return;
    }
    if (rt.isPlaying) rebaseToVideo();
    else startMetronome();
  }
  function onRateChange() {
    if (!rt.video) return;
    rt.playbackRate = rt.video.playbackRate || 1;
    // Rebase rather than stop/start: keeps the lock and the beat numbering.
    if (isVideoDriven() && rt.isPlaying) rebaseToVideo();
  }

  function syncVideoListeners() {
    if (!rt.video) return;
    const shouldAttach = isVideoDriven();
    if (shouldAttach && !rt.listenersAttached) {
      for (const [ev, fn] of VIDEO_EVENTS) rt.video.addEventListener(ev, fn);
      rt.listenersAttached = true;
    } else if (!shouldAttach && rt.listenersAttached) {
      for (const [ev, fn] of VIDEO_EVENTS) rt.video.removeEventListener(ev, fn);
      rt.listenersAttached = false;
    }
  }

  function attachVideo(el) {
    if (rt.video === el) return;
    detachVideo();
    rt.video = el;
    rt.playbackRate = el.playbackRate || 1;
    syncVideoListeners();
    disarmDetection();
    if (settings.mode === 'auto' && !el.paused && !el.ended && !rt.adShowing) {
      startMetronome();
    }
    pushState();
  }

  function detachVideo() {
    if (!rt.video) return;
    if (rt.listenersAttached) {
      for (const [ev, fn] of VIDEO_EVENTS) rt.video.removeEventListener(ev, fn);
      rt.listenersAttached = false;
    }
    rt.video = null;
    rt.playbackRate = 1;
    // Auto and manual+locked depend on the video; free-running manual keeps going.
    if (isVideoDriven()) stopMetronome();
    armDetection();
    pushState();
  }

  // Only bind the main player. A bare querySelector('video') also matches the
  // homepage hover-preview player, which would start the click while browsing.
  function isPreviewVideo(el) {
    return !!(el.closest && el.closest('ytd-video-preview, #video-preview'));
  }

  function findMainVideo() {
    const el = document.querySelector('#movie_player video.html5-main-video')
      || document.querySelector('video.html5-main-video')
      || document.querySelector('#movie_player video');
    if (el) return el;
    const generic = document.querySelector('video');
    if (generic && !isPreviewVideo(generic)) return generic;
    return null;
  }

  function findVideo() {
    const el = findMainVideo();
    if (el && el !== rt.video) attachVideo(el);
    else if (!el && rt.video) detachVideo();
    else if (rt.video && !document.contains(rt.video)) detachVideo();
    watchAdState();
    updateVideoContext();
  }

  // --- Per-video memory ------------------------------------------------------
  function getVideoId() {
    const { pathname, search } = window.location;
    if (pathname === '/watch') {
      const m = /[?&]v=([^&]+)/.exec(search || '');
      return m ? m[1] : null;
    }
    const s = /^\/shorts\/([^/?]+)/.exec(pathname);
    return s ? s[1] : null;
  }

  // On navigation to a remembered video, restore its snapshot by writing the
  // settings keys — the normal storage.onChanged path then applies them here,
  // in other tabs, and in the popup, exactly as if the user had set them.
  async function updateVideoContext() {
    const id = getVideoId();
    if (id === currentVideoId) return;
    currentVideoId = id;
    if (!id) return;
    let memory;
    try {
      memory = (await chrome.storage.local.get(MEMORY_KEY))[MEMORY_KEY] || {};
    } catch (_) { return; }
    const entry = memory[id];
    if (!entry) return;
    if (currentVideoId !== id) return; // navigated again while reading
    const clean = sanitizeSettings({ ...settings, ...entry });
    const partial = {};
    for (const k of MEMORY_FIELDS) {
      if (clean[k] !== settings[k]) partial[k] = clean[k];
    }
    if (Object.keys(partial).length === 0) return;
    try { chrome.storage.local.set(partial); } catch (_) { /* noop */ }
  }

  // A snapshot is only ever written after the user changes a remembered
  // setting on this video (so untouched videos never accumulate entries), and
  // only from the visible tab (a background tab reacting to another tab's
  // change must not claim the snapshot for its own video).
  function scheduleMemorySave() {
    if (!currentVideoId || document.hidden) return;
    if (memorySaveTimer) clearTimeout(memorySaveTimer);
    memorySaveTimer = setTimeout(saveVideoMemory, MEMORY_SAVE_DEBOUNCE_MS);
  }

  async function saveVideoMemory() {
    memorySaveTimer = null;
    const id = currentVideoId;
    if (!id) return;
    let memory;
    try {
      memory = (await chrome.storage.local.get(MEMORY_KEY))[MEMORY_KEY] || {};
    } catch (_) { return; }
    const entry = { savedAt: Date.now() };
    for (const k of MEMORY_FIELDS) entry[k] = settings[k];
    memory[id] = entry;
    const ids = Object.keys(memory)
      .sort((a, b) => (memory[b].savedAt || 0) - (memory[a].savedAt || 0));
    for (const stale of ids.slice(MEMORY_LIMIT)) delete memory[stale];
    try { chrome.storage.local.set({ [MEMORY_KEY]: memory }); } catch (_) { /* noop */ }
  }

  // YouTube marks the player element with .ad-showing during ads. Clicking
  // over an ad is useless (and the ad runs on its own timeline), so treat ads
  // like a pause: stop while showing, resync when content resumes.
  function watchAdState() {
    const player = document.getElementById('movie_player');
    if (player === rt.playerEl) return;
    if (rt.adObserver) { rt.adObserver.disconnect(); rt.adObserver = null; }
    rt.playerEl = player;
    if (!player) { rt.adShowing = false; return; }
    const update = () => {
      const showing = player.classList.contains('ad-showing')
        || player.classList.contains('ad-interrupting');
      if (showing === rt.adShowing) return;
      rt.adShowing = showing;
      if (!isVideoDriven()) return;
      if (showing) {
        if (rt.isPlaying) pauseScheduler();
      } else if (videoPlayingNow()) {
        startMetronome();
      }
      pushState();
    };
    rt.adObserver = new MutationObserver(update);
    rt.adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    update();
  }

  // Detection is armed only while no video is bound — YouTube mutates the DOM
  // constantly, and running querySelector on every mutation forever is wasted
  // work once we hold the (long-lived) player element.
  let detectObserver = null;
  let detectPollTimer = null;

  function armDetection() {
    if (!detectObserver) {
      detectObserver = new MutationObserver(() => findVideo());
      detectObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (detectPollTimer) clearTimeout(detectPollTimer);
    let tries = 0;
    const poll = () => {
      detectPollTimer = null;
      if (rt.video) return;
      findVideo();
      if (!rt.video && tries < 40) {
        tries += 1;
        detectPollTimer = setTimeout(poll, 250);
      }
    };
    poll();
  }

  function disarmDetection() {
    if (detectObserver) {
      detectObserver.disconnect();
      detectObserver = null;
    }
    if (detectPollTimer) {
      clearTimeout(detectPollTimer);
      detectPollTimer = null;
    }
  }

  // --- Manual hotkeys --------------------------------------------------------------
  function isTypingTarget(e) {
    const t = e.target;
    if (!t) return false;
    const tn = (t.tagName || '').toUpperCase();
    if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT') return true;
    if (t.isContentEditable) return true;
    return false;
  }

  function onHotkeyDown(e) {
    if (settings.mode !== 'manual') return;
    if (!settings.enabled) return;
    if (isTypingTarget(e)) return;
    if (e.repeat) return;
    // Don't hijack browser/page shortcuts like Cmd+B.
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const isStart = e.code === settings.hotkey;
    const isLock = e.code === settings.lockHotkey;
    if (!isStart && !isLock) return;

    // Suppress the page's own handling of this key. YouTube registers
    // handlers on window/document, so stopImmediatePropagation is needed to
    // truly decouple in manual mode.
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

    if (isStart) {
      if (rt.isPlaying) stopMetronome();
      else startMetronome();
      return;
    }
    // Lock hotkey — only meaningful while the metronome is running.
    if (rt.isPlaying) {
      if (rt.locked) unlockFromVideo();
      else lockToVideo();
    }
  }

  // --- Popup port ---------------------------------------------------------------------
  function publicState() {
    const videoPresent = !!rt.video && document.contains(rt.video);
    const videoPlaying = videoPresent && !rt.video.paused && !rt.video.ended;
    // Manual+unlocked runs independently of video state; auto and
    // manual+locked are gated by it.
    const runningNow = isVideoDriven()
      ? rt.isPlaying && videoPlaying
      : rt.isPlaying;
    return {
      type: 'state',
      mode: settings.mode,
      enabled: settings.enabled,
      locked: rt.locked,
      isPlaying: runningNow,
      currentBeat: runningNow ? rt.currentBeat : 0,
      adShowing: rt.adShowing,
      videoPresent,
      videoPlaying
    };
  }

  function pushToPort(msg) {
    if (!port) return;
    try { port.postMessage(msg); } catch (_) { port = null; }
  }

  function pushState() {
    pushToPort(publicState());
  }

  function onPortCommand(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'MANUAL_TOGGLE') {
      if (settings.mode !== 'manual' || !settings.enabled) return;
      if (rt.isPlaying) stopMetronome();
      else startMetronome();
    } else if (msg.type === 'TOGGLE_LOCK') {
      if (settings.mode !== 'manual' || !rt.isPlaying) return;
      if (rt.locked) unlockFromVideo();
      else lockToVideo();
    }
  }

  // --- Settings sync (storage is the single source of truth; popup writes it) ----------
  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    const raw = { ...settings };
    for (const key of Object.keys(changes)) raw[key] = changes[key].newValue;
    const prev = settings;
    settings = sanitizeSettings(raw);

    if (prev.volume !== settings.volume) applyVolume();
    if (prev.mode !== settings.mode) {
      applyMode();
    }
    if (prev.enabled !== settings.enabled) {
      if (!settings.enabled) stopMetronome();
      else if (settings.mode === 'auto' && videoPlayingNow() && !rt.adShowing) startMetronome();
    }
    if (prev.bpm !== settings.bpm) onTempoChanged(prev.bpm);
    if (prev.syncOffsetMs !== settings.syncOffsetMs && isVideoDriven() && rt.isPlaying) {
      rebaseToVideo();
    }
    // sig / barOffset / accentEnabled / subdivision / clickSound need no
    // rescheduling — the scheduler reads them per beat.
    if (MEMORY_FIELDS.some((k) => prev[k] !== settings[k])) scheduleMemorySave();
    pushState();
  }

  // --- Init ------------------------------------------------------------------------------
  async function init() {
    let stored = {};
    try { stored = await chrome.storage.local.get(null); } catch (_) { /* first run */ }
    settings = sanitizeSettings(stored);

    chrome.storage.onChanged.addListener(onStorageChanged);

    chrome.runtime.onConnect.addListener((p) => {
      if (p.name !== PORT_NAME) return;
      if (port) { try { port.disconnect(); } catch (_) { /* stale */ } }
      port = p;
      p.onMessage.addListener(onPortCommand);
      p.onDisconnect.addListener(() => { if (port === p) port = null; });
      pushState();
    });

    // Capture phase on both window and document: window fires first, ahead of
    // YouTube's own keyboard handlers; stopImmediatePropagation on a match
    // keeps the document-level copy from double-firing.
    window.addEventListener('keydown', onHotkeyDown, true);
    document.addEventListener('keydown', onHotkeyDown, true);

    // On hide, immediately buffer clicks ahead before Chrome throttles our
    // timers; on show, the next pass tightens back up on its own.
    document.addEventListener('visibilitychange', () => {
      if (rt.isPlaying && rt.schedulerTimer) {
        clearTimeout(rt.schedulerTimer);
        schedulerPass();
      }
    });

    // YouTube is a SPA — video changes arrive via soft navigation, not reload.
    document.addEventListener('yt-navigate-finish', () => findVideo());
    window.addEventListener('pageshow', () => {
      findVideo();
      if (rt.isPlaying && isVideoDriven()) rebaseToVideo();
    });

    armDetection();
    findVideo();
  }

  // Isolated-world only (invisible to page scripts); used by tests/run.js.
  window.__syncoBeatTest = {
    getState: () => ({
      settings: { ...settings },
      isPlaying: rt.isPlaying,
      locked: rt.locked,
      phaseOffset: rt.phaseOffset,
      beatCounter: rt.beatCounter,
      nextNoteTime: rt.nextNoteTime,
      currentBeat: rt.currentBeat,
      adShowing: rt.adShowing,
      hasVideo: !!rt.video
    })
  };

  init();
})();
